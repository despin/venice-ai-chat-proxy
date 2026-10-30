import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import {
  OPENCODE_SYSTEM_PROMPT,
  OPENCODE_TASK,
  OPENCODE_TOOLS,
  OPENCODE_WRITE_CONTENT,
  OPENCODE_WRITE_CONTENT_BLANK_END,
  OPENCODE_WRITE_PATH,
  opencodeTask,
} from "./opencode-fixture.mjs";

// Live check of emulated tool calling against a running proxy (needs a valid
// Venice session). Model replies vary, so failures here may be the model
// breaking the format rather than the proxy.

const PORT = Number(process.env.PORT || process.env.VENICE_PROXY_PORT || 3456);
const BASE_URL = process.env.CHECK_PROXY_BASE_URL?.trim() || `http://localhost:${PORT}/v1`;
const MODEL = process.env.CHECK_PROXY_MODEL?.trim() || "zai-org-glm-5-2";
const OPENCODE_RUNS = Number(process.env.CHECK_TOOLS_OPENCODE_RUNS || 5);
// "opencode" runs only the opencode-like scenario (e.g. to compare formats).
const ONLY = process.env.CHECK_TOOLS_ONLY?.trim() || null;
// Sent as reasoning_effort on every request when set; "none" turns Venice's
// reasoning off, to measure its effect on tool calls.
const REASONING_EFFORT = process.env.CHECK_TOOLS_REASONING_EFFORT?.trim() || null;
// Minimum share of opencode-like runs per mode that must produce the right call.
const OPENCODE_MIN_RATE = Number(process.env.CHECK_TOOLS_OPENCODE_MIN_RATE || 0.8);

const WEATHER_RESULT = "Paris: 18°C, light rain, wind 12 km/h";
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name, e.g. Paris" } },
        required: ["city"],
      },
    },
  },
];

// ──────────────────────────────────────────────
// Test runner helpers
// ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// Runs one completion and returns { content, toolCalls, finishReason,
// attempts } for both streaming and non-streaming requests. attempts is the
// number of upstream requests the proxy needed (2 after a retry), reported
// because the client sends x-venice-tool-debug.
async function complete(client, request) {
  const body = REASONING_EFFORT ? { ...request, reasoning_effort: REASONING_EFFORT } : request;
  if (!body.stream) {
    const response = await client.chat.completions.create(body);
    const choice = response.choices?.[0];
    return {
      content: choice?.message?.content ?? null,
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason ?? null,
      attempts: response.venice_tool_attempts ?? null,
    };
  }

  const stream = await client.chat.completions.create(body);
  let content = "";
  let finishReason = null;
  let attempts = null;
  const toolCalls = [];
  for await (const chunk of stream) {
    attempts = chunk.venice_tool_attempts ?? attempts;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (typeof choice.delta?.content === "string") {
      content += choice.delta.content;
    }
    for (const part of choice.delta?.tool_calls ?? []) {
      const call = (toolCalls[part.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name = part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
    }
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }
  return { content: content || null, toolCalls: toolCalls.filter(Boolean), finishReason, attempts };
}

function parseArguments(call) {
  try {
    return JSON.parse(call?.function?.arguments ?? "");
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

async function testToolRoundTrip(client, model, stream) {
  section(`tool round trip — stream=${stream}`);

  const messages = [
    { role: "user", content: "What is the weather in Paris right now? Use the get_weather tool." },
  ];
  const first = await complete(client, { model, messages, tools: TOOLS, stream });
  const call = first.toolCalls[0];
  const args = parseArguments(call);

  ok("finish_reason is 'tool_calls'", first.finishReason === "tool_calls", `got ${first.finishReason}`);
  ok("a get_weather call is returned", call?.function?.name === "get_weather",
    `content=${JSON.stringify(first.content)}`);
  ok("call id is a non-empty string", typeof call?.id === "string" && call.id.length > 0);
  ok("arguments are JSON with city≈Paris",
    typeof args?.city === "string" && args.city.toLowerCase().includes("paris"),
    `arguments=${call?.function?.arguments}`);
  console.log(`  info  content before call = ${JSON.stringify(first.content)}`);

  if (!call) {
    return;
  }

  const followUp = [
    ...messages,
    { role: "assistant", content: first.content, tool_calls: first.toolCalls },
    { role: "tool", tool_call_id: call.id, content: WEATHER_RESULT },
  ];
  const second = await complete(client, { model, messages: followUp, tools: TOOLS, stream });

  ok("final finish_reason is 'stop'", second.finishReason === "stop", `got ${second.finishReason}`);
  ok("final answer has no tool calls", second.toolCalls.length === 0);
  ok("final answer uses the tool result",
    typeof second.content === "string" && /18/.test(second.content),
    `content=${JSON.stringify(second.content)}`);
  console.log(`  info  final answer = ${JSON.stringify(second.content)}`);
}

async function testWithoutTools(client, model, stream) {
  section(`no tools — stream=${stream}`);

  const result = await complete(client, {
    model,
    messages: [{ role: "user", content: "Say exactly: hello world" }],
    stream,
  });
  ok("finish_reason is 'stop'", result.finishReason === "stop", `got ${result.finishReason}`);
  ok("content is a non-empty string", typeof result.content === "string" && result.content.length > 0);
  ok("no tool_calls", result.toolCalls.length === 0);
  console.log(`  info  content = ${JSON.stringify(result.content)}`);
}

// Where two strings first differ, with a little context on both sides, e.g.
// 'at char 57 (line 3, col 18): expected …"C:\\\\Users"… got …"C:\\Users"…'.
export function describeFirstDifference(expected, actual, context = 15) {
  let index = 0;
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) {
    index += 1;
  }
  if (index === expected.length && index === actual.length) {
    return "identical";
  }
  const before = expected.slice(0, index);
  const line = before.split("\n").length;
  const column = index - before.lastIndexOf("\n");
  const around = (text) =>
    `${index > context ? "…" : ""}${JSON.stringify(text.slice(Math.max(0, index - context), index + context))}${index + context < text.length ? "…" : ""}`;
  return `at char ${index} (line ${line}, col ${column}): expected ${around(expected)} got ${around(actual)}; lengths ${expected.length} vs ${actual.length}`;
}

// A long agent prompt and opencode's real tools, asking for a write()
// whose content is full of quotes and backslashes. Reports the success rate.
// Trailing newlines are compared separately: a run counts as a success when
// the content matches apart from them, and how many runs kept them exactly is
// reported on its own (models differ; the proxy never drops them).
const trailingNewlines = (text) => /\n*$/.exec(text)[0].length;

async function testOpencodeScenario(client, model, stream, {
  label = "opencode-like write",
  content = OPENCODE_WRITE_CONTENT,
  task = OPENCODE_TASK,
} = {}) {
  section(`${label} — stream=${stream}, ${OPENCODE_RUNS} runs`);
  console.log(`  info  system prompt ${OPENCODE_SYSTEM_PROMPT.length} chars, ${OPENCODE_TOOLS.length} tools`);

  const expected = content.replace(/\n*$/, "\n");
  let successes = 0;
  let exactTrailing = 0;
  let retried = 0;
  for (let run = 1; run <= OPENCODE_RUNS; run += 1) {
    const startedAt = Date.now();
    let result;
    try {
      result = await complete(client, {
        model,
        stream,
        tools: OPENCODE_TOOLS,
        messages: [
          { role: "system", content: OPENCODE_SYSTEM_PROMPT },
          { role: "user", content: task },
        ],
      });
    } catch (error) {
      console.log(`  run ${run}: request failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const write = result.toolCalls.find((call) => call.function?.name === "write");
    const args = parseArguments(write);
    const pathOk = args?.path === OPENCODE_WRITE_PATH;
    const contentOk = typeof args?.content === "string" && args.content.replace(/\n*$/, "\n") === expected;
    const success = Boolean(write) && pathOk && contentOk && result.finishReason === "tool_calls";
    successes += success ? 1 : 0;
    const trailingOk = success && trailingNewlines(args.content) === trailingNewlines(content);
    exactTrailing += trailingOk ? 1 : 0;

    retried += result.attempts > 1 ? 1 : 0;

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const timing = `${seconds}s, attempts=${result.attempts ?? "?"}`;
    if (success) {
      const trailing = trailingOk
        ? ""
        : `, trailing newlines: expected ${trailingNewlines(content)}, got ${trailingNewlines(args.content)}`;
      console.log(`  run ${run}: ok (${timing}${trailing})`);
    } else {
      const names = result.toolCalls.map((call) => call.function?.name).join(",") || "none";
      const detail = !write
        ? `calls=${names} finish=${result.finishReason} content=${JSON.stringify((result.content ?? "").slice(0, 200))}`
        : !pathOk
          ? `path=${JSON.stringify(args?.path)}`
          : typeof args?.content !== "string"
            ? `content is ${JSON.stringify(args?.content)}`
            : `content differs ${describeFirstDifference(expected, args.content.replace(/\n*$/, "\n"))}`;
      console.log(`  run ${run}: FAILED (${timing}) ${detail}`);
    }
  }

  const rate = OPENCODE_RUNS > 0 ? successes / OPENCODE_RUNS : 0;
  console.log(`  info  success rate ${successes}/${OPENCODE_RUNS} (${Math.round(rate * 100)}%), ${retried} run(s) needed a retry`);
  console.log(`  info  trailing newlines exact in ${exactTrailing}/${successes} successful run(s)`);
  ok(`success rate ≥ ${Math.round(OPENCODE_MIN_RATE * 100)}%`, rate >= OPENCODE_MIN_RATE, `${successes}/${OPENCODE_RUNS}`);
  return { successes, exactTrailing, runs: OPENCODE_RUNS };
}

// ──────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────

async function main() {
  console.log(`Proxy base URL: ${BASE_URL}`);
  console.log(`Using model: ${MODEL}${REASONING_EFFORT ? ` (reasoning_effort=${REASONING_EFFORT})` : ""}`);

  const client = new OpenAI({
    baseURL: BASE_URL,
    apiKey: "venice-web-session",
    defaultHeaders: { "x-venice-tool-debug": "1" },
  });

  if (ONLY !== "opencode") {
    for (const stream of [false, true]) {
      await testToolRoundTrip(client, MODEL, stream);
      await testWithoutTools(client, MODEL, stream);
    }
  }

  const rates = [];
  const trailing = [];
  for (const stream of [false, true]) {
    const { successes, exactTrailing, runs } = await testOpencodeScenario(client, MODEL, stream);
    rates.push(`stream=${stream}: ${successes}/${runs}`);
    trailing.push(`stream=${stream}: ${exactTrailing}/${successes}`);
  }
  for (const stream of [false, true]) {
    const { exactTrailing, successes } = await testOpencodeScenario(client, MODEL, stream, {
      label: "opencode-like write, file ending in a blank line",
      content: OPENCODE_WRITE_CONTENT_BLANK_END,
      task: opencodeTask(OPENCODE_WRITE_CONTENT_BLANK_END, "The file ends with a blank line: keep both final newlines."),
    });
    trailing.push(`blank-line stream=${stream}: ${exactTrailing}/${successes}`);
  }
  console.log(`\nopencode-like success rate (${MODEL}): ${rates.join(", ")}`);
  console.log(`trailing newlines kept exactly (of successful runs): ${trailing.join(", ")}`);

  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
