import crypto from "node:crypto";
import { normalizeOpenAiContent } from "./openai-content.mjs";

// Prompt-based tool calling. Venice's web endpoints take no client tools, so the
// tools are described in the system prompt, the model answers with
// <tool_call>{json}</tool_call> blocks, and those are parsed back into OpenAI
// tool_calls. Everything here is pure so it can be checked without the network.

const OPEN_TAG = "<tool_call";
const CLOSE_TAG = "</tool_call>";

// Tags that open a call block in model output. Wrapper tags need a ">" (after
// optional whitespace) and their body excludes the tags.
const CALL_TAGS = [{ open: OPEN_TAG, close: CLOSE_TAG, wrapper: true }];
const SNIPPET_MAX_CHARS = 200;

export function parseToolEmulationSetting(value) {
  if (typeof value !== "string") {
    return true;
  }
  switch (value.trim().toLowerCase()) {
    case "off":
    case "0":
    case "false":
    case "no":
      return false;
    default:
      return true;
  }
}

export function truncateSnippet(text, maxChars = SNIPPET_MAX_CHARS) {
  const value = typeof text === "string" ? text : String(text);
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

// Keeps only well-formed function tools; anything else is ignored rather than
// failing the request.
export function normalizeTools(tools) {
  const result = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const fn = tool?.type === "function" ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || !fn.name.trim()) {
      continue;
    }
    result.push({
      name: fn.name.trim(),
      description: typeof fn.description === "string" ? fn.description.trim() : "",
      parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : null,
    });
  }
  return result;
}

// Returns "none", "auto", "required" or { name }.
export function normalizeToolChoice(toolChoice) {
  if (toolChoice === "none" || toolChoice === "required" || toolChoice === "auto") {
    return toolChoice;
  }
  const name = toolChoice?.type === "function" ? toolChoice.function?.name : null;
  if (typeof name === "string" && name.trim()) {
    return { name: name.trim() };
  }
  return "auto";
}

function describeToolChoice(toolChoice) {
  return typeof toolChoice === "string" ? toolChoice : `function:${toolChoice.name}`;
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// The generic tool list: name, description and compact JSON Schema per tool,
// then the tagged-JSON call format under the given tag.
function describeTaggedJson(tools, tag) {
  const lines = [
    "# Tools",
    "",
    "You can call the tools listed below. Call a tool whenever it helps you complete the user's request.",
    "",
    "## Available tools",
  ];
  for (const tool of tools) {
    lines.push("", `### ${tool.name}`);
    if (tool.description) {
      lines.push(tool.description);
    }
    lines.push(`Parameters (JSON Schema): ${JSON.stringify(tool.parameters ?? { type: "object", properties: {} })}`);
  }
  lines.push(
    "",
    "## How to call a tool",
    "",
    "To call a tool, write a block in exactly this format:",
    "",
    `<${tag}>{"name": "TOOL_NAME", "arguments": {"ARGUMENT": "VALUE"}}</${tag}>`,
  );
  return lines;
}

function renderTaggedResult(tag, { name, id, content }) {
  const idPart = id ? ` id="${escapeAttribute(id)}"` : "";
  return `<${tag} name="${escapeAttribute(name)}"${idPart}>${content}</${tag}>`;
}

// What the model is asked to write: the instructions, and how earlier calls
// and results are rendered into history.
const TOOL_FORMATS = {
  // Generic tagged JSON, for models without a known native format.
  json: {
    describe(tools) {
      return describeTaggedJson(tools, "tool_call");
    },
    formatRules: [
      '- Inside each <tool_call> block put exactly one valid JSON object with the keys "name" and "arguments". "arguments" is a JSON object that matches the tool\'s parameters. No markdown code fences, comments or other text inside the tags.',
    ],
    resultDescription: '<tool_result name="TOOL_NAME" id="CALL_ID">...</tool_result> blocks',
    example: '<tool_call>{"name": "TOOL_NAME", "arguments": {"ARGUMENT": "VALUE"}}</tool_call>',
    reminder: 'to call a tool, write <tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call> with valid JSON inside.',
    renderCall(name, args) {
      return `${OPEN_TAG}>${JSON.stringify({ name, arguments: args })}${CLOSE_TAG}`;
    },
    renderResult({ name, id, content }) {
      return renderTaggedResult("tool_result", { name, id, content });
    },
  },
};

export function buildToolSystemPrompt(tools, toolChoice = "auto", { parallel = true, format = "json" } = {}) {
  const normalizedTools = normalizeTools(tools);
  const choice = normalizeToolChoice(toolChoice);
  const spec = TOOL_FORMATS[format] ?? TOOL_FORMATS.json;
  const tag = spec.tag ?? "tool_call";
  const lines = [
    ...spec.describe(normalizedTools),
    "",
    "Rules:",
    ...spec.formatRules,
    parallel
      ? `- Use one <${tag}> block per call. To call several tools, write several blocks one after another.`
      : `- Call at most one tool per reply, with a single <${tag}> block.`,
    `- You may write a short message before the first block. Write nothing after the last </${tag}>; end your reply there.`,
    `- Never invent, predict or describe tool results. After your tool calls, stop and wait: the results arrive in the next message as ${spec.resultDescription}.`,
    "- Use only the tools listed above, with their exact names.",
  ];

  const forcedName =
    typeof choice === "object" && normalizedTools.some((tool) => tool.name === choice.name)
      ? choice.name
      : null;
  if (forcedName) {
    lines.push(`- You must call the tool "${forcedName}" in this reply.`);
  } else if (choice === "required") {
    lines.push("- You must call at least one tool in this reply.");
  } else {
    lines.push(`- If no tool is needed, answer normally without any <${tag}> block.`);
  }

  return lines.join("\n");
}

// Rebuilds a call block from an OpenAI tool call so the model sees its earlier
// calls in the same format it is asked to write.
function renderToolCallBlock(toolCall, spec) {
  const name = toolCall?.function?.name;
  if (typeof name !== "string" || !name) {
    return null;
  }
  let args = toolCall.function.arguments;
  if (typeof args === "string") {
    if (!args.trim()) {
      args = {};
    } else {
      try {
        args = JSON.parse(args);
      } catch {
        // Keep the original string; the model still sees what was sent.
      }
    }
  } else if (args === undefined || args === null) {
    args = {};
  }
  return spec.renderCall(name, args);
}

// Turns OpenAI history with tool_calls/tool messages into plain system/user/
// assistant text messages, the shape splitMessages() and
// convertToWorkflowMessages() already understand.
export function renderHistoryWithTools(messages, { format = "json" } = {}) {
  const spec = TOOL_FORMATS[format] ?? TOOL_FORMATS.json;
  const list = Array.isArray(messages) ? messages : [];
  const callNames = new Map();
  for (const message of list) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const toolCall of message.tool_calls) {
      if (typeof toolCall?.id === "string" && typeof toolCall.function?.name === "string") {
        callNames.set(toolCall.id, toolCall.function.name);
      }
    }
  }

  const rendered = [];
  const push = (message) => {
    const previous = rendered.at(-1);
    // Merge same-role neighbours (e.g. several tool results) so the upstream
    // sees one turn per side. Messages carrying reasoning_content stay separate:
    // the agent path decodes embedded history from it.
    if (
      previous &&
      previous.role === message.role &&
      message.role !== "system" &&
      previous.reasoning_content === undefined &&
      message.reasoning_content === undefined
    ) {
      previous.content = `${previous.content}\n\n${message.content}`;
      return;
    }
    rendered.push(message);
  };

  for (const message of list) {
    const role = typeof message?.role === "string" ? message.role : "user";
    const content = normalizeOpenAiContent(message?.content);

    if (role === "system") {
      if (content) {
        push({ role: "system", content });
      }
      continue;
    }

    if (role === "tool" || role === "function") {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      const name =
        callNames.get(id) ?? (typeof message.name === "string" && message.name ? message.name : "unknown");
      push({ role: "user", content: spec.renderResult({ name, id, content }) });
      continue;
    }

    if (role === "assistant") {
      const blocks = [
        ...(Array.isArray(message.tool_calls) ? message.tool_calls : []),
        // Legacy single function_call field.
        ...(message.function_call ? [{ function: message.function_call }] : []),
      ]
        .map((toolCall) => renderToolCallBlock(toolCall, spec))
        .filter(Boolean);
      const text = [content, blocks.join("\n")].filter(Boolean).join("\n\n");
      const reasoning =
        typeof message.reasoning_content === "string" && message.reasoning_content
          ? message.reasoning_content
          : undefined;
      if (!text && reasoning === undefined) {
        continue;
      }
      push(reasoning === undefined ? { role: "assistant", content: text } : { role: "assistant", content: text, reasoning_content: reasoning });
      continue;
    }

    if (content) {
      push({ role: "user", content });
    }
  }

  return rendered;
}

// Appends the tool section to the last system message, or adds one, so it
// ends the joined system prompt (and the agent path's [System] message): with
// a long client prompt, instructions at the end are the ones that stick.
export function injectToolPrompt(messages, toolPrompt) {
  const result = [...messages];
  const lastSystem = result.findLastIndex((message) => message.role === "system");
  if (lastSystem === -1) {
    result.unshift({ role: "system", content: toolPrompt });
    return result;
  }
  const last = result[lastSystem];
  result[lastSystem] = { ...last, content: `${last.content}\n\n${toolPrompt}` };
  return result;
}

export function toolFormatReminder(format = "json") {
  const spec = TOOL_FORMATS[format] ?? TOOL_FORMATS.json;
  return `[Tool call format: ${spec.reminder} One block per call; write nothing after the last </${spec.tag ?? "tool_call"}>.]`;
}

// Repeats the format in one line on the latest user turn (usually the tool
// results), right where the model looks before answering.
export function appendToolReminder(messages, format = "json") {
  const result = [...messages];
  const lastUser = result.findLastIndex((message) => message.role === "user");
  if (lastUser !== -1) {
    const message = result[lastUser];
    result[lastUser] = { ...message, content: `${message.content}\n\n${toolFormatReminder(format)}` };
  }
  return result;
}

// Returns null when the request should keep the old, tool-less behavior.
export function resolveToolEmulation(payload, { enabled = true } = {}) {
  if (!enabled || !Array.isArray(payload?.tools)) {
    return null;
  }
  const tools = normalizeTools(payload.tools);
  const toolChoice = normalizeToolChoice(payload.tool_choice);
  if (tools.length === 0 || toolChoice === "none") {
    return null;
  }
  const parallel = payload.parallel_tool_calls !== false;
  const format = "json";
  const toolPrompt = buildToolSystemPrompt(payload.tools, toolChoice, { parallel, format });
  return {
    tools,
    toolNames: tools.map((tool) => tool.name),
    toolChoice,
    toolChoiceLabel: describeToolChoice(toolChoice),
    format,
    maxCalls: parallel ? Infinity : 1,
    messages: appendToolReminder(
      injectToolPrompt(renderHistoryWithTools(payload.messages, { format }), toolPrompt),
      format,
    ),
  };
}

function createToolCallId() {
  return `call_${crypto.randomBytes(12).toString("hex")}`;
}

function stripFence(text) {
  const match = /^```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/.exec(text);
  return match ? match[1].trim() : text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Accepts tool names, normalized tools, or an existing index; returns
// name → tool (with its JSON Schema parameters, when known).
export function indexTools(tools) {
  if (tools instanceof Map) {
    return tools;
  }
  const index = new Map();
  for (const tool of tools ?? []) {
    if (typeof tool === "string") {
      index.set(tool, { name: tool, parameters: null });
    } else if (typeof tool?.name === "string") {
      index.set(tool.name, tool);
    }
  }
  return index;
}

function buildToolCall(tool, args) {
  return {
    toolCall: {
      id: createToolCallId(),
      type: "function",
      function: { name: tool.name, arguments: JSON.stringify(args) },
    },
  };
}

function parseJsonArgs(tool, value) {
  const name = tool.name;
  let args = value ?? {};
  if (typeof args === "string") {
    if (!args.trim()) {
      args = {};
    } else {
      try {
        args = JSON.parse(args);
      } catch {
        return { error: `invalid JSON arguments for "${name}"` };
      }
    }
  }
  if (!isPlainObject(args)) {
    return { error: `arguments for "${name}" are not an object` };
  }
  return buildToolCall(tool, args);
}

// Parses the inside of a <tool_call> block: a JSON object {"name",
// "arguments"|"parameters"}, or the OpenAI shape {"function": {"name",
// "arguments"}}. Returns { toolCall } or { error }.
export function parseCallBody(raw, tools) {
  const index = indexTools(tools);
  const body = stripFence(String(raw).trim());
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: "invalid JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { error: "not a JSON object" };
  }
  const call = typeof parsed.name !== "string" && isPlainObject(parsed.function) ? parsed.function : parsed;
  if (typeof call.name !== "string") {
    return { error: "missing tool name" };
  }
  const tool = index.get(call.name);
  if (!tool) {
    return { error: `unknown tool "${call.name}"` };
  }
  return parseJsonArgs(tool, call.arguments ?? call.parameters);
}

// Fallback for replies that skip the tags: the whole reply, or one fenced block,
// is a call object naming a known tool.
function parseUntaggedCall(text, tools) {
  const trimmed = text.trim();
  let body = null;
  if (trimmed.startsWith("{")) {
    body = trimmed;
  } else {
    const match = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/i.exec(trimmed);
    if (match && !match[1].includes("```")) {
      body = match[1];
    }
  }
  if (body === null) {
    return { error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: null };
  }
  // Ordinary JSON answers are not tool attempts; only a {name, arguments}
  // shape is parsed (and warned about when it does not resolve).
  const call = isPlainObject(parsed?.function) ? parsed.function : parsed;
  if (
    !isPlainObject(call) ||
    typeof call.name !== "string" ||
    !("arguments" in call || "parameters" in call)
  ) {
    return { error: null };
  }
  return parseCallBody(body, tools);
}

// Whether a reply that starts this way could be an untagged JSON call:
// "yes", "no", or "maybe" while too short to tell.
function untaggedCallPrefix(text) {
  if (text.startsWith("{")) {
    return "yes";
  }
  if (!text.startsWith("`")) {
    return "no";
  }
  if (/^```(?:json)?[ \t]*(?:\r?\n)?\s*\{/i.test(text)) {
    return "yes";
  }
  if (/^`{1,3}$/.test(text) || /^```(?:j(?:s(?:o(?:n)?)?)?)?$/i.test(text) || /^```(?:json)?[ \t]*(?:\r?\n)?\s*$/i.test(text)) {
    return "maybe";
  }
  return "no";
}

// Length of the longest suffix of `text` that is a proper prefix of `tag`.
function partialTagLength(text, tag) {
  for (let length = Math.min(text.length, tag.length - 1); length > 0; length -= 1) {
    if (tag.startsWith(text.slice(-length))) {
      return length;
    }
  }
  return 0;
}

// Incremental parser for streamed content. push()/end() return events:
//   { type: "text", text }           answer text, passed on as soon as it
//                                    cannot be part of a tag
//   { type: "tool_call", toolCall }  a parsed call
//   { type: "invalid", raw, reason } a block that could not be parsed; its
//                                    text is never released as content here
//   { type: "stop" }                 the reply is complete: after a call the
//                                    model went on with something other than
//                                    another call, or maxCalls was reached
// Nothing is returned after "stop", and text after the first call is dropped.
export function createToolCallParser(tools, { maxCalls = Infinity } = {}) {
  const known = indexTools(tools);
  // start: nothing but whitespace seen; hold: buffering a possible untagged
  // call to the end; text: scanning for an open tag; tag: inside a block.
  let mode = "start";
  let buffer = "";
  let openTagText = "";
  let currentTag = CALL_TAGS[0];
  let toolCallCount = 0;
  let stopped = false;
  // Trailing whitespace is held back so a call-only reply streams no stray
  // newlines; it is flushed with the next text or at the end.
  let pendingWhitespace = "";
  let events = [];

  const emitText = (text) => {
    if (!text || toolCallCount > 0) {
      return;
    }
    const combined = pendingWhitespace + text;
    const body = combined.trimEnd();
    pendingWhitespace = combined.slice(body.length);
    if (body) {
      events.push({ type: "text", text: body });
    }
  };

  const flushWhitespace = () => {
    if (pendingWhitespace && toolCallCount === 0) {
      events.push({ type: "text", text: pendingWhitespace });
    }
    pendingWhitespace = "";
  };

  const stop = () => {
    stopped = true;
    buffer = "";
    events.push({ type: "stop" });
  };

  const emitCall = (result, raw) => {
    if (result.toolCall) {
      toolCallCount += 1;
      events.push({ type: "tool_call", toolCall: result.toolCall });
      if (toolCallCount >= maxCalls) {
        stop();
      }
      return;
    }
    events.push({ type: "invalid", raw, reason: result.error ?? "unparsed tool call" });
  };

  const scan = () => {
    while (!stopped) {
      if (mode === "start") {
        const trimmed = buffer.trimStart();
        if (!trimmed) {
          return;
        }
        const prefix = untaggedCallPrefix(trimmed);
        if (prefix === "maybe") {
          return;
        }
        mode = prefix === "yes" ? "hold" : "text";
        continue;
      }

      if (mode === "hold") {
        return;
      }

      if (mode === "text") {
        if (toolCallCount > 0) {
          // After a call only another call may follow; anything else (an
          // apology, a "fixed" retry, a summary) ends the reply. A stray
          // </tool_call> is skipped.
          const trimmed = buffer.trimStart().replace(/^(?:<\/tool_call>\s*)+/, "");
          if (!trimmed || CALL_TAGS.some((tag) => tag.wrapper && tag.close.startsWith(trimmed))) {
            buffer = trimmed;
            return;
          }
          const mayContinue = CALL_TAGS.some(({ open }) => trimmed.startsWith(open) || open.startsWith(trimmed));
          if (!mayContinue) {
            stop();
            return;
          }
          buffer = trimmed;
        }
        let tag = null;
        let index = -1;
        for (const candidate of CALL_TAGS) {
          const found = buffer.indexOf(candidate.open);
          if (found !== -1 && (index === -1 || found < index)) {
            tag = candidate;
            index = found;
          }
        }
        if (!tag) {
          const keep = Math.max(...CALL_TAGS.map(({ open }) => partialTagLength(buffer, open)));
          emitText(buffer.slice(0, buffer.length - keep));
          buffer = buffer.slice(buffer.length - keep);
          return;
        }
        if (!tag.wrapper) {
          emitText(buffer.slice(0, index));
          buffer = buffer.slice(index);
          openTagText = "";
          currentTag = tag;
          mode = "tag";
          continue;
        }
        const after = buffer.slice(index + tag.open.length);
        const close = /^\s*>/.exec(after);
        if (close) {
          emitText(buffer.slice(0, index));
          openTagText = buffer.slice(index, index + tag.open.length + close[0].length);
          buffer = buffer.slice(index + openTagText.length);
          currentTag = tag;
          mode = "tag";
          continue;
        }
        if (/^\s*$/.test(after)) {
          // Still could become "<tool_call>"; wait for more.
          emitText(buffer.slice(0, index));
          buffer = buffer.slice(index);
          return;
        }
        // "<tool_calls", "<tool_call_x" and the like are plain text.
        emitText(buffer.slice(0, index + 1));
        buffer = buffer.slice(index + 1);
        continue;
      }

      // mode === "tag"
      const closeIndex = buffer.indexOf(currentTag.close);
      if (closeIndex === -1) {
        return;
      }
      const end = closeIndex + currentTag.close.length;
      const body = currentTag.wrapper ? buffer.slice(0, closeIndex) : buffer.slice(0, end);
      buffer = buffer.slice(end);
      mode = "text";
      emitCall(parseCallBody(body, known), currentTag.wrapper ? `${openTagText}${body}${currentTag.close}` : body);
    }
  };

  const drain = () => {
    const out = events;
    events = [];
    return out;
  };

  return {
    get toolCallCount() {
      return toolCallCount;
    },

    push(text) {
      if (!stopped && typeof text === "string" && text) {
        buffer += text;
        scan();
      }
      return drain();
    },

    end() {
      if (stopped) {
        return drain();
      }
      if (mode === "hold") {
        const fallback = parseUntaggedCall(buffer, known);
        if (fallback.toolCall || fallback.error) {
          const raw = buffer;
          buffer = "";
          emitCall(fallback, raw);
          return drain();
        }
        // Not a call after all: treat it as ordinary text, tags included.
        mode = "text";
        scan();
        if (stopped) {
          return drain();
        }
      }

      if (mode === "tag") {
        // Unterminated block, usually an output-length cut-off.
        const body = buffer;
        const result = parseCallBody(body, known);
        emitCall(
          result.toolCall ? result : { error: `unterminated tool call (${result.error})` },
          `${openTagText}${body}`,
        );
      } else if (toolCallCount === 0) {
        emitText(buffer);
      }
      flushWhitespace();
      buffer = "";
      mode = "text";
      return drain();
    },
  };
}

// Non-streaming parse built on the same state machine. Unparsed blocks come
// back as text (and through onWarning), the behavior without a retry.
export function parseToolCalls(text, tools, { onWarning = () => {}, ...options } = {}) {
  const parser = createToolCallParser(tools, options);
  const source = typeof text === "string" ? text : "";
  const toolCalls = [];
  let content = "";
  for (const event of [...parser.push(source), ...parser.end()]) {
    if (event.type === "tool_call") {
      toolCalls.push(event.toolCall);
    } else if (event.type === "invalid") {
      onWarning({ reason: event.reason, snippet: truncateSnippet(event.raw) });
      if (toolCalls.length === 0) {
        content += event.raw;
      }
    } else if (event.type === "text") {
      content += event.text;
    }
  }
  if (toolCalls.length === 0) {
    return { content: source, toolCalls };
  }
  return { content: content.trim() || null, toolCalls };
}

// The two streaming deltas for one call: id and name first (what
// @ai-sdk/openai-compatible requires to open a call), then the arguments.
export function buildToolCallDeltas(toolCall, index) {
  return [
    {
      tool_calls: [
        {
          index,
          id: toolCall.id,
          type: "function",
          function: { name: toolCall.function.name, arguments: "" },
        },
      ],
    },
    {
      tool_calls: [{ index, function: { arguments: toolCall.function.arguments } }],
    },
  ];
}

// Runs one emulated completion. openAttempt(messages) returns an async
// iterable of upstream events { type: "meta" | "reasoning" | "content" }.
// Yields client events { type: "meta" | "reasoning" | "text" | "tool_call" }.
//
// Reading stops as soon as the reply is complete: after a call only another
// call may follow, so the model cannot go on with "let me fix that". A block
// that cannot be parsed before any call comes back as text; onEvent reports
// it ("unparsed"), and an unparsed block after a call ("dropped").
export async function* runToolEmulation({ emulation, openAttempt, onEvent = () => {}, stats = {} }) {
  stats.attempts = 1;
  stats.toolCalls = 0;
  const parser = createToolCallParser(emulation.tools, { maxCalls: emulation.maxCalls });
  let finished = false;

  // Applies parser events and returns the ones the client should see.
  const apply = (events) => {
    const visible = [];
    for (const event of events) {
      if (finished) {
        break;
      }
      if (event.type === "text") {
        visible.push(event);
      } else if (event.type === "tool_call") {
        stats.toolCalls += 1;
        visible.push(event);
      } else if (event.type === "stop") {
        finished = true;
      } else if (event.type === "invalid") {
        if (stats.toolCalls > 0) {
          onEvent({ type: "dropped", reason: event.reason, outputs: [event.raw] });
          finished = true;
        } else {
          onEvent({ type: "unparsed", reason: event.reason, outputs: [event.raw] });
          visible.push({ type: "text", text: event.raw });
        }
      }
    }
    return visible;
  };

  for await (const event of openAttempt(emulation.messages)) {
    if (event.type === "content") {
      yield* apply(parser.push(event.text));
      if (finished) {
        break;
      }
    } else if (event.type === "reasoning" || event.type === "meta") {
      yield event;
    }
  }
  if (!finished) {
    yield* apply(parser.end());
  }
}
