import crypto from "node:crypto";

const DEFAULT_AGENTIC_MODEL = "kimi-k2-5";

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function* parseSseStream(stream) {
  if (!stream) return;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let eventName = null;
        let dataLine = null;

        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLine = line.slice(5).trim();
          }
        }

        if (dataLine !== null) {
          yield { event: eventName, data: safeJsonParse(dataLine) };
        }
      }
    }

    buffer += decoder.decode();
    const remaining = buffer.trim();
    if (remaining) {
      let eventName = null;
      let dataLine = null;
      for (const line of remaining.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
      }
      if (dataLine !== null) {
        yield { event: eventName, data: safeJsonParse(dataLine) };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// Marker used to round-trip structured history through the client's message store.
const HIST_RE = /\[__vc_hist__\]([\w+/]+=*)\[\/[_a-z]+vc_hist__\]/;

function decodeEmbeddedHistory(reasoningContent) {
  if (typeof reasoningContent !== "string") return [];
  const match = HIST_RE.exec(reasoningContent);
  if (!match) return [];
  try {
    return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  } catch {
    return [];
  }
}

export function convertToWorkflowMessages(openAiMessages) {
  const result = [];
  for (const msg of Array.isArray(openAiMessages) ? openAiMessages : []) {
    const role = typeof msg?.role === "string" ? msg.role : "user";
    const text = normalizeContent(msg?.content);

    const id = crypto.randomBytes(8).toString("base64url");

    if (role === "system") {
      if (!text) continue;
      result.push({
        type: "message",
        role: "user",
        id,
        status: "completed",
        content: [{ type: "output_text", text: `[System]\n${text}`, annotations: [] }],
      });
    } else if (role === "tool") {
      if (!text) continue;
      result.push({
        type: "message",
        role: "assistant",
        id,
        status: "completed",
        content: [{ type: "output_text", text: `Tool result:\n${text}`, annotations: [] }],
      });
    } else if (role === "assistant") {
      // Decode embedded turn history (reasoning items + function calls/results)
      // produced by a previous agentic response; if present, expand them before
      // the final message item so outerface receives the full tool-call context.
      const embedded = decodeEmbeddedHistory(msg?.reasoning_content);
      if (embedded.length > 0) {
        result.push(...embedded);
      }
      if (text) {
        result.push({
          type: "message",
          role: "assistant",
          id,
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        });
      }
    } else {
      if (!text) continue;
      result.push({
        type: "message",
        role: "user",
        id,
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      });
    }
  }
  return result;
}

export class AgenticProxy {
  constructor(client) {
    this.client = client;
  }

  agentModelId() {
    return process.env.VENICE_AGENTIC_MODEL?.trim() || DEFAULT_AGENTIC_MODEL;
  }

  // Used by the /v1/responses handler — single-request, pass-through stream.
  async openStream(jwt, input) {
    const messages = Array.isArray(input)
      ? convertToWorkflowMessages(input)
      : convertToWorkflowMessages([{ role: "user", content: String(input) }]);
    return this.client.openWorkflowChatStream(jwt, messages, { agentModelId: this.agentModelId() });
  }

  // Used by the agentic /v1/chat/completions handler.
  // Yields every SSE event from outerface, across as many HTTP turns as needed,
  // stopping only when outerface signals response.completed with status=completed.
  //
  // Within each outerface turn the server executes all tool calls autonomously and
  // keeps the stream open — the loop only re-enters when the stream closes without
  // a completed status (e.g. a mid-search connection drop), reconstructing history
  // from the events already received so outerface can resume.
  async *agenticEventStream(jwt, openAiMessages) {
    const MAX_TURNS = 20;

    let messages = Array.isArray(openAiMessages)
      ? convertToWorkflowMessages(openAiMessages)
      : convertToWorkflowMessages([{ role: "user", content: String(openAiMessages) }]);

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = await this.client.openWorkflowChatStream(jwt, messages, {
        agentModelId: this.agentModelId(),
      });

      // Per-turn bookkeeping for history reconstruction if we need another turn.
      // output_index → raw item (from response.output_item.done)
      const outputItems = new Map();
      // item_id → full text (from response.output_text.done)
      const itemTexts = new Map();
      let sessionCompleted = false;

      for await (const sseEvent of stream.events) {
        yield sseEvent;

        const { event, data } = sseEvent;

        if (event === "response.output_item.done" && data?.item) {
          outputItems.set(data.output_index ?? -1, data.item);
        }

        if (
          event === "response.output_text.done" &&
          typeof data?.item_id === "string" &&
          typeof data?.text === "string"
        ) {
          itemTexts.set(data.item_id, data.text);
        }

        if (
          event === "response.completed" &&
          data?.response?.status === "completed"
        ) {
          sessionCompleted = true;
        }
      }

      // Normal case (what the HAR shows): one stream, fully completed.
      if (sessionCompleted) {
        yield {
          event: "__vc:session_done__",
          data: { items: buildNextTurnItems(outputItems, itemTexts) },
        };
        break;
      }

      // Abnormal case: stream closed before completion (network drop during tool
      // execution, etc.).  Reconstruct history from collected items and retry.
      const nextItems = buildNextTurnItems(outputItems, itemTexts);
      if (nextItems.length === 0) break; // nothing to add — give up rather than loop forever

      messages = [...messages, ...nextItems];
    }
  }
}

/**
 * Reconstruct the workflow-format message history from items and texts
 * accumulated during one outerface turn so they can be appended to the next
 * request when a turn ends without response.completed status=completed.
 *
 * Item types seen in the HAR (from response.output_item.done):
 *   reasoning                          — text lives in response.output_text.done
 *   veniceai:tool_call_generation      — internal marker, skip
 *   veniceai:web_search                — search metadata, skip (captured via server_function_call_output)
 *   veniceai:server_function_call      — maps to "function_call" in continuation history
 *   veniceai:server_function_call_output — maps to "function_call_output" in continuation history
 *   message (role=assistant)           — text lives in response.output_text.done
 */
function buildNextTurnItems(outputItems, itemTexts) {
  const sorted = [...outputItems.entries()].sort(([a], [b]) => a - b);
  const result = [];

  for (const [, item] of sorted) {
    const type = item?.type;
    if (!type) continue;

    // Internal markers — not sent back to outerface.
    if (type === "veniceai:tool_call_generation" || type === "veniceai:web_search") continue;

    if (type === "reasoning") {
      const text = itemTexts.get(item.id) ?? "";
      result.push({
        type: "reasoning",
        id: item.id,
        status: "completed",
        summary: text ? [{ type: "summary_text", text }] : [],
      });
      continue;
    }

    if (type === "message" && item.role === "assistant") {
      const text = itemTexts.get(item.id) ?? "";
      result.push({
        type: "message",
        role: "assistant",
        id: item.id,
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      });
      continue;
    }

    // HAR shows the continuation history uses "function_call" / "function_call_output",
    // not the "veniceai:server_*" names used inside the SSE stream.
    if (type === "veniceai:server_function_call") {
      result.push({
        type: "function_call",
        id: item.id,
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
        status: "completed",
      });
      continue;
    }

    if (type === "veniceai:server_function_call_output") {
      result.push({
        type: "function_call_output",
        id: item.id,
        call_id: item.call_id,
        output: item.output,
        status: "completed",
      });
      continue;
    }

    // Unknown future types — pass through unchanged.
    result.push(item);
  }

  return result;
}
