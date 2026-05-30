import { pathToFileURL } from "node:url";
import { startVeniceOpenAiProxyServer } from "./venice-openai-proxy.mjs";

const DEFAULT_PROMPTS = [
  "Concurrency test stream A. Count slowly from 1 to 40, one number per short sentence.",
  "Concurrency test stream B. Count slowly from 101 to 140, one number per short sentence.",
  "Concurrency test stream C. Count slowly from 201 to 240, one number per short sentence.",
];

const MODEL = process.env.CHECK_PROXY_CONCURRENCY_MODEL?.trim();
const PROMPTS = parsePrompts(process.env.CHECK_PROXY_CONCURRENCY_PROMPTS);

function parsePrompts(value) {
  if (!value?.trim()) {
    return DEFAULT_PROMPTS;
  }

  const prompts = value
    .split(/\n---\n/)
    .map((prompt) => prompt.trim())
    .filter(Boolean);

  if (prompts.length === 0) {
    return DEFAULT_PROMPTS;
  }
  return prompts;
}

function nowMs() {
  return performance.now();
}

function elapsed(startedAt) {
  return `${Math.round(nowMs() - startedAt)}ms`;
}

function parseSseData(buffer) {
  const chunks = buffer.split(/\n\n/);
  const tail = chunks.pop() ?? "";
  const data = [];

  for (const chunk of chunks) {
    const lines = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (lines.length > 0) {
      data.push(lines.join("\n"));
    }
  }

  return { data, tail };
}

async function runStream({ baseUrl, index, prompt, startedAt, contentBatches }) {
  const label = `stream-${index + 1}`;
  const requestStartedAt = nowMs();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL || undefined,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label} failed with HTTP ${response.status}: ${text}`);
  }
  if (!response.body) {
    throw new Error(`${label} response has no body`);
  }

  console.log(
    `[${elapsed(startedAt)}] ${label} headers received after ${Math.round(
      nowMs() - requestStartedAt,
    )}ms`,
  );

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chars = 0;
  let chunks = 0;
  let firstTokenAt = null;
  let lastTokenAt = null;
  const batches = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseData(buffer);
      buffer = parsed.tail;
      const batchAt = nowMs();
      let batchChars = 0;
      let batchChunks = 0;

      for (const data of parsed.data) {
        if (data === "[DONE]") {
          continue;
        }

        const event = JSON.parse(data);
        const content = event?.choices?.[0]?.delta?.content;
        if (typeof content !== "string" || content.length === 0) {
          continue;
        }

        chars += content.length;
        chunks += 1;
        batchChars += content.length;
        batchChunks += 1;
        lastTokenAt = batchAt;
        if (firstTokenAt == null) {
          firstTokenAt = batchAt;
          console.log(`[${elapsed(startedAt)}] ${label} first content chunk`);
        }
      }

      if (batchChars > 0) {
        const batch = {
          label,
          atMs: Math.round(batchAt - startedAt),
          chars: batchChars,
          chunks: batchChunks,
        };
        batches.push(batch);
        contentBatches.push(batch);
      }
    }

    buffer += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  const finishedAt = nowMs();
  console.log(
    `[${elapsed(startedAt)}] ${label} done chunks=${chunks} chars=${chars}`,
  );

  return {
    label,
    requestStartedMs: Math.round(requestStartedAt - startedAt),
    firstTokenMs:
      firstTokenAt == null ? null : Math.round(firstTokenAt - startedAt),
    lastTokenMs: lastTokenAt == null ? null : Math.round(lastTokenAt - startedAt),
    finishedMs: Math.round(finishedAt - startedAt),
    chunks,
    chars,
    batches,
  };
}

function getStreamStats(result) {
  const largestBatchChars = Math.max(
    0,
    ...result.batches.map((batch) => batch.chars),
  );
  const largestBatchShare =
    result.chars > 0 ? Math.round((largestBatchChars / result.chars) * 100) : 0;
  const contentDurationMs =
    typeof result.firstTokenMs === "number" &&
    typeof result.lastTokenMs === "number"
      ? result.lastTokenMs - result.firstTokenMs
      : 0;
  const bulkDelivered =
    result.chars > 0 &&
    (result.batches.length <= 2 ||
      largestBatchShare >= 80 ||
      (contentDurationMs <= 500 && largestBatchShare >= 60));

  return {
    batchCount: result.batches.length,
    largestBatchChars,
    largestBatchShare,
    contentDurationMs,
    bulkDelivered,
  };
}

function countLabelTransitions(contentBatches) {
  const ordered = [...contentBatches].sort((a, b) => {
    if (a.atMs !== b.atMs) {
      return a.atMs - b.atMs;
    }
    return a.label.localeCompare(b.label);
  });

  let transitions = 0;
  let previousLabel = null;
  for (const batch of ordered) {
    if (previousLabel && previousLabel !== batch.label) {
      transitions += 1;
    }
    previousLabel = batch.label;
  }
  return transitions;
}

function streamsOverlap(results) {
  const windows = results
    .filter(
      (result) =>
        typeof result.firstTokenMs === "number" &&
        typeof result.lastTokenMs === "number",
    )
    .map((result) => ({
      label: result.label,
      start: result.firstTokenMs,
      end: result.lastTokenMs,
    }));

  for (let left = 0; left < windows.length; left += 1) {
    for (let right = left + 1; right < windows.length; right += 1) {
      if (
        windows[left].start <= windows[right].end &&
        windows[right].start <= windows[left].end
      ) {
        return true;
      }
    }
  }

  return false;
}

function printVerdict(results, contentBatches) {
  const firstTokens = results
    .filter((result) => typeof result.firstTokenMs === "number")
    .map((result) => result.firstTokenMs);
  const finishes = results.map((result) => result.finishedMs);

  if (firstTokens.length < 2) {
    console.log("Verdict: inconclusive; fewer than two streams produced content.");
    return;
  }

  const firstTokenSpread = Math.max(...firstTokens) - Math.min(...firstTokens);
  const finishSpread = Math.max(...finishes) - Math.min(...finishes);
  const earliestFinish = Math.min(...finishes);
  const latestFirstToken = Math.max(...firstTokens);
  const statsByLabel = new Map(
    results.map((result) => [result.label, getStreamStats(result)]),
  );
  const bulkStreams = results.filter(
    (result) => statsByLabel.get(result.label)?.bulkDelivered,
  );
  const transitions = countLabelTransitions(contentBatches);
  const hasOverlappingContentWindows = streamsOverlap(results);

  console.log("");
  console.log("Summary:");
  for (const result of results) {
    const stats = statsByLabel.get(result.label);
    console.log(
      `- ${result.label}: first_token=${result.firstTokenMs ?? "none"}ms last_token=${result.lastTokenMs ?? "none"}ms finished=${result.finishedMs}ms batches=${stats.batchCount} chunks=${result.chunks} chars=${result.chars} largest_batch=${stats.largestBatchShare}% content_span=${stats.contentDurationMs}ms`,
    );
  }

  console.log("");
  if (bulkStreams.length > 0) {
    console.log(
      `Verdict: likely serialized or buffered. ${bulkStreams
        .map((result) => result.label)
        .join(", ")} received most content in one short burst, so first-token overlap is not enough to call this true concurrent streaming.`,
    );
    return;
  }

  if (
    latestFirstToken < earliestFinish &&
    hasOverlappingContentWindows &&
    transitions >= results.length
  ) {
    console.log(
      `Verdict: concurrent streaming. Streams produced overlapping, incremental content batches. first_token_spread=${firstTokenSpread}ms finish_spread=${finishSpread}ms stream_switches=${transitions}`,
    );
    return;
  }

  console.log(
    `Verdict: likely sequential or upstream-throttled. Token batches did not overlap enough to show true concurrent streaming. first_token_spread=${firstTokenSpread}ms finish_spread=${finishSpread}ms stream_switches=${transitions}`,
  );
}

async function main() {
  const { server, host, port } = await startVeniceOpenAiProxyServer({
    host: "127.0.0.1",
    port: 0,
  });

  try {
    const address = server.address();
    const resolvedPort = typeof address === "object" && address ? address.port : port;
    const baseUrl = `http://${host}:${resolvedPort}/v1`;
    const startedAt = nowMs();

    console.log(`Proxy base URL: ${baseUrl}`);
    console.log(`Streams: ${PROMPTS.length}`);
    if (MODEL) {
      console.log(`Model: ${MODEL}`);
    }
    console.log("");

    const contentBatches = [];
    const results = await Promise.all(
      PROMPTS.map((prompt, index) =>
        runStream({ baseUrl, index, prompt, startedAt, contentBatches }),
      ),
    );
    printVerdict(results, contentBatches);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
