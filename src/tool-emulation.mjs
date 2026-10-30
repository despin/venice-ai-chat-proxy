import crypto from "node:crypto";
import { normalizeOpenAiContent } from "./openai-content.mjs";

// Prompt-based tool calling. Venice's web endpoints take no client tools, so the
// tools are described in the system prompt, the model answers with
// <tool_call>{json}</tool_call> blocks, and those are parsed back into OpenAI
// tool_calls. Everything here is pure so it can be checked without the network.

const OPEN_TAG = "<tool_call";
const CLOSE_TAG = "</tool_call>";
const PROXY_OPEN_TAG = "<proxy_call";
const PROXY_CLOSE_TAG = "</proxy_call>";

// Tags that open a call block in model output. Wrapper tags need a ">" (after
// optional whitespace) and their body excludes the tags. Qwen XML models
// sometimes drop the <tool_call> wrapper and write <function=NAME>…</function>
// alone; that block keeps its tag in the body.
const CALL_TAGS = [
  { open: OPEN_TAG, close: CLOSE_TAG, wrapper: true },
  { open: PROXY_OPEN_TAG, close: PROXY_CLOSE_TAG, wrapper: true },
  { open: "<function=", close: "</function>", wrapper: false },
];
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

function toolDefinitionJson(tool) {
  return JSON.stringify({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  });
}

// Lists tools the way GLM and Qwen chat templates do: one JSON definition per
// line inside <tools></tools>.
function nativeToolList(tools) {
  return [
    "# Tools",
    "",
    "You may call one or more functions to assist with the user query.",
    "",
    "You are provided with function signatures within <tools></tools> XML tags:",
    "<tools>",
    ...tools.map(toolDefinitionJson),
    "</tools>",
  ];
}

// Qwen3.5+ and Qwen3-Coder chat templates: the call format and its rules,
// verbatim, after the tool list.
const QWEN_XML_CALL_INSTRUCTIONS = [
  "If you choose to call a function ONLY reply in the following format with NO suffix:",
  "",
  "<tool_call>",
  "<function=example_function_name>",
  "<parameter=example_parameter_1>",
  "value_1",
  "</parameter>",
  "<parameter=example_parameter_2>",
  "This is the value for the second parameter",
  "that can span",
  "multiple lines",
  "</parameter>",
  "</function>",
  "</tool_call>",
  "",
  "<IMPORTANT>",
  "Reminder:",
  "- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags",
  "- Required parameters MUST be specified",
  "- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after",
  "- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls",
  "</IMPORTANT>",
];

// Jinja's `| string` of a scalar, as the Qwen3-Coder template prints it.
function jinjaString(value) {
  if (value === true || value === false) {
    return value ? "True" : "False";
  }
  return value === null ? "None" : String(value);
}

// The Qwen3-Coder template's render_extra_keys macro.
function renderExtraKeys(object, handledKeys) {
  if (!isPlainObject(object)) {
    return "";
  }
  return Object.entries(object)
    .filter(([key]) => !handledKeys.includes(key))
    .map(([key, value]) => `\n<${key}>${value !== null && typeof value === "object" ? JSON.stringify(value) : jinjaString(value)}</${key}>`)
    .join("");
}

// Qwen3-Coder lists tools as XML rather than JSON.
function qwenCoderToolList(tools) {
  const entries = tools.map((tool) => {
    let text = `\n<function>\n<name>${tool.name}</name>`;
    if (tool.description) {
      text += `\n<description>${tool.description}</description>`;
    }
    text += "\n<parameters>";
    const properties = tool.parameters?.properties;
    if (isPlainObject(properties)) {
      for (const [name, fields] of Object.entries(properties)) {
        text += `\n<parameter>\n<name>${name}</name>`;
        if (fields?.type !== undefined) {
          text += `\n<type>${Array.isArray(fields.type) ? JSON.stringify(fields.type) : fields.type}</type>`;
        }
        if (typeof fields?.description === "string") {
          text += `\n<description>${fields.description.trim()}</description>`;
        }
        text += `${renderExtraKeys(fields, ["name", "type", "description"])}\n</parameter>`;
      }
    }
    text += `${renderExtraKeys(tool.parameters, ["type", "properties"])}\n</parameters>\n</function>`;
    return text;
  });
  return ["# Tools", "", "You have access to the following functions:", "", `<tools>${entries.join("")}`, "</tools>"];
}

// <tool_call><function=NAME><parameter=KEY>VALUE</parameter>…: string values
// raw, others as JSON (Qwen3.5+ template; Coder prints scalars via | string).
function renderQwenXmlCall(name, args) {
  if (!isPlainObject(args)) {
    return TOOL_FORMATS.json.renderCall(name, args);
  }
  const parameters = Object.entries(args).map(
    ([key, value]) => `<parameter=${key}>\n${typeof value === "string" ? value : JSON.stringify(value)}\n</parameter>\n`,
  );
  return `${OPEN_TAG}>\n<function=${name}>\n${parameters.join("")}</function>\n${CLOSE_TAG}`;
}

// Spelling out "real line breaks, never \\n" made Qwen3-Coder over-correct
// (it turned a \\n that belongs in source code into a line break: 5/20 exact,
// against 5/10 with this wording), so the rule stays short.
const QWEN_XML_FORMAT_RULES = [
  "- Write each parameter value exactly as it is, with no surrounding quotes and no escaping, even when it spans several lines. Write numbers, booleans, arrays and objects as JSON.",
];
const QWEN_XML_EXAMPLE = "<tool_call>\n<function=TOOL_NAME>\n<parameter=ARGUMENT>\nVALUE\n</parameter>\n</function>\n</tool_call>";
const QWEN_XML_REMINDER =
  "to call a tool, write <tool_call><function=TOOL_NAME><parameter=KEY>VALUE</parameter></function></tool_call>; values raw, never JSON-escaped.";

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

function nativeToolResult({ content }) {
  return `<tool_response>\n${content}\n</tool_response>`;
}

// What the model is asked to write, per format. Every format is accepted on
// the way back (see parseCallBody); this only picks the instructions and how
// earlier calls and results are rendered into history.
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

  // Tagged JSON under a tag no server-side tool parser knows, for models whose
  // <tool_call> blocks Venice consumes before they reach the proxy (Qwen 3.5+).
  // The prompt never spells out that tag: a model told "never <tool_call>"
  // repeats it while thinking, and Venice then cuts everything from there on,
  // the real <proxy_call> included (seen in raw dumps of empty replies).
  proxy: {
    tag: "proxy_call",
    describe(tools) {
      return describeTaggedJson(tools, "proxy_call");
    },
    formatRules: [
      '- Inside each <proxy_call> block put exactly one valid JSON object with the keys "name" and "arguments". "arguments" is a JSON object that matches the tool\'s parameters. No markdown code fences, comments or other text inside the tags.',
      "- Always use <proxy_call> tags. Do not write any other tool-call tag or syntax, not even while thinking: other tags are removed before your reply arrives, together with everything after them.",
    ],
    resultDescription: '<proxy_result name="TOOL_NAME" id="CALL_ID">...</proxy_result> blocks',
    example: '<proxy_call>{"name": "TOOL_NAME", "arguments": {"ARGUMENT": "VALUE"}}</proxy_call>',
    reminder: 'to call a tool, write <proxy_call>{"name": "TOOL_NAME", "arguments": {...}}</proxy_call> with valid JSON inside; no other tool-call tags, not even in your reasoning.',
    renderCall(name, args) {
      return `${PROXY_OPEN_TAG}>${JSON.stringify({ name, arguments: args })}${PROXY_CLOSE_TAG}`;
    },
    renderResult({ name, id, content }) {
      return renderTaggedResult("proxy_result", { name, id, content });
    },
  },

  // GLM's native XML-ish format (GLM-4.5+ chat template).
  glm: {
    describe(tools) {
      return [
        ...nativeToolList(tools),
        "",
        "For each function call, output the function name and arguments within the following XML format:",
        "<tool_call>{function-name}",
        "<arg_key>{arg-key-1}</arg_key>",
        "<arg_value>{arg-value-1}</arg_value>",
        "<arg_key>{arg-key-2}</arg_key>",
        "<arg_value>{arg-value-2}</arg_value>",
        "...",
        "</tool_call>",
      ];
    },
    formatRules: [
      "- Write string values inside <arg_value> exactly as they are: no surrounding quotes and no escaping, even when they span several lines. Write numbers, booleans, arrays and objects as JSON.",
      "- Do not write the call as JSON and do not wrap it in code fences.",
    ],
    resultDescription: "<tool_response>...</tool_response> blocks, in the order of your calls",
    example: "<tool_call>TOOL_NAME\n<arg_key>ARGUMENT</arg_key>\n<arg_value>VALUE</arg_value>\n</tool_call>",
    reminder:
      "to call a tool, write <tool_call>TOOL_NAME then <arg_key>KEY</arg_key><arg_value>VALUE</arg_value> for each argument, then </tool_call>; string values raw, never JSON.",
    renderCall(name, args) {
      if (!isPlainObject(args)) {
        return TOOL_FORMATS.json.renderCall(name, args);
      }
      const pairs = Object.entries(args).map(
        ([key, value]) =>
          `\n<arg_key>${key}</arg_key>\n<arg_value>${typeof value === "string" ? value : JSON.stringify(value)}</arg_value>`,
      );
      return `${OPEN_TAG}>${name}${pairs.join("")}\n${CLOSE_TAG}`;
    },
    renderResult: nativeToolResult,
  },

  // Qwen's tagged JSON (Qwen2.5, Qwen3 incl. 2507, Qwen3-VL chat templates).
  qwen: {
    describe(tools) {
      return [
        ...nativeToolList(tools),
        "",
        "For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:",
        "<tool_call>",
        '{"name": <function-name>, "arguments": <args-json-object>}',
        "</tool_call>",
      ];
    },
    formatRules: [
      '- Inside each <tool_call> block put exactly one valid JSON object with the keys "name" and "arguments". No markdown code fences or other text inside the tags.',
    ],
    resultDescription: "<tool_response>...</tool_response> blocks, in the order of your calls",
    example: '<tool_call>\n{"name": "TOOL_NAME", "arguments": {"ARGUMENT": "VALUE"}}\n</tool_call>',
    reminder: 'to call a tool, write <tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call> with valid JSON inside.',
    renderCall(name, args) {
      return `${OPEN_TAG}>\n{"name": ${JSON.stringify(name)}, "arguments": ${JSON.stringify(args)}}\n${CLOSE_TAG}`;
    },
    renderResult: nativeToolResult,
  },

  // Qwen3.5 and later (3.6, 3.8) template: XML calls, tools listed as JSON
  // lines. Opt-in only: Venice strips these calls upstream.
  "qwen-xml": {
    describe(tools) {
      return [
        "# Tools",
        "",
        "You have access to the following functions:",
        "",
        "<tools>",
        ...tools.map(toolDefinitionJson),
        "</tools>",
        "",
        ...QWEN_XML_CALL_INSTRUCTIONS,
      ];
    },
    formatRules: QWEN_XML_FORMAT_RULES,
    resultDescription: "<tool_response>...</tool_response> blocks, in the order of your calls",
    example: QWEN_XML_EXAMPLE,
    reminder: QWEN_XML_REMINDER,
    renderCall: renderQwenXmlCall,
    renderResult: nativeToolResult,
  },

  // Qwen3-Coder: the same XML calls, tools listed as XML.
  "qwen-coder": {
    describe(tools) {
      return [...qwenCoderToolList(tools), "", ...QWEN_XML_CALL_INSTRUCTIONS];
    },
    formatRules: QWEN_XML_FORMAT_RULES,
    resultDescription: "<tool_response>...</tool_response> blocks, in the order of your calls",
    example: QWEN_XML_EXAMPLE,
    reminder: QWEN_XML_REMINDER,
    renderCall: renderQwenXmlCall,
    renderResult: nativeToolResult,
  },
};

export const TOOL_FORMAT_NAMES = Object.keys(TOOL_FORMATS);

// Model id → format, checked in order; the first match wins. Templates say
// Qwen3-Coder and Qwen 3.5+ use XML calls and Qwen3, Qwen3-2507 and Qwen3-VL
// tagged JSON, but live runs decide where they disagree:
//
// Qwen3-Coder gets the generic JSON format: in the opencode-like check it
// wrote the exact file in 20/20 runs with JSON and 5/20 with its native XML
// (escaping or unescaping backslashes in raw values).
//
// Qwen 3.5 and later ("qwen3-6-27b", "qwen-3-8-27b") get the neutral proxy
// format: Venice parses their <tool_call> blocks server-side and drops them.
// A raw dump of /api/inference/chat for Qwen 3.8 showed only meta/content
// events with the call cut out of the text, even mid-reasoning; Qwen 3.6 did
// the same (no call, no parser warning, only whitespace left). The version
// must be followed by "-", "." or the end: "qwen3-8b" is Qwen3 8B, not 3.8.
const DEFAULT_FORMAT_RULES = [
  { match: /glm/, format: "glm" },
  { match: /qwen-?3[.-]?coder/, format: "json" },
  { match: /qwen-?3[.-][5-9](?=[-.]|$)/, format: "proxy" },
  { match: /qwen/, format: "qwen" },
];

// Parses VENICE_TOOL_FORMATS, e.g. "glm=json,kimi=qwen,*=json". Entries are
// matched before the defaults; "*" matches every model.
export function parseToolFormatRules(value) {
  const rules = [];
  const invalid = [];
  for (const entry of typeof value === "string" ? value.split(",") : []) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const [pattern, format] = trimmed.split("=").map((part) => part?.trim().toLowerCase());
    if (pattern && TOOL_FORMATS[format]) {
      rules.push({ pattern, format });
    } else {
      invalid.push(trimmed);
    }
  }
  return { rules, invalid };
}

export function resolveToolFormat(model, rules = []) {
  const id = typeof model === "string" ? model.toLowerCase() : "";
  for (const rule of [...rules, ...DEFAULT_FORMAT_RULES]) {
    if (rule.match ? rule.match.test(id) : rule.pattern === "*" || id.includes(rule.pattern)) {
      return rule.format;
    }
  }
  return "json";
}

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
export function resolveToolEmulation(payload, { enabled = true, model = payload?.model, formatRules = [] } = {}) {
  if (!enabled || !Array.isArray(payload?.tools)) {
    return null;
  }
  const tools = normalizeTools(payload.tools);
  const toolChoice = normalizeToolChoice(payload.tool_choice);
  if (tools.length === 0 || toolChoice === "none") {
    return null;
  }
  const parallel = payload.parallel_tool_calls !== false;
  const format = resolveToolFormat(model, formatRules);
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

// A call missing a required argument would fail in the client anyway, so it
// counts as unparsed (and can be retried) rather than being returned.
function buildToolCall(tool, args) {
  const name = tool.name;
  const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
  const missing = required.filter((key) => !(key in args));
  if (missing.length > 0) {
    return { error: `missing required argument${missing.length > 1 ? "s" : ""} ${missing.map((key) => `"${key}"`).join(", ")} for "${name}"` };
  }
  return {
    toolCall: {
      id: createToolCallId(),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  };
}

// Models often put raw newlines or tabs inside JSON strings (a file body,
// say). Escapes control characters that sit inside string literals.
export function escapeControlCharsInStrings(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      } else if (char < " ") {
        result +=
          char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (char === '"') {
      inString = true;
    }
    result += char;
  }
  return result;
}

// The first balanced {...} in text (string-aware), or null.
function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

// JSON.parse, then with control characters escaped, then on the first
// balanced object only (drops trailing junk such as stray closing tags).
// Returns { value } or null.
export function parseJsonLenient(text, { whole = false } = {}) {
  const attempts = [text];
  const repaired = escapeControlCharsInStrings(text);
  if (repaired !== text) {
    attempts.push(repaired);
  }
  const extracted = whole ? null : extractJsonObject(repaired);
  if (extracted && extracted !== repaired.trim()) {
    attempts.push(extracted);
  }
  for (const attempt of attempts) {
    try {
      return { value: JSON.parse(attempt) };
    } catch {
      // Try the next repair.
    }
  }
  return null;
}

function schemaTypes(schema) {
  if (schema?.type === undefined) {
    return [];
  }
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

// Turns one raw <arg_value> into a JSON value: string-typed parameters keep the
// text as written, anything else is read as JSON when it parses (like vLLM's
// GLM parser), with Python literals tolerated.
function convertArgValue(raw, schema) {
  const types = schemaTypes(schema);
  if (types.length > 0 && types.every((type) => type === "string" || type === "null")) {
    return raw;
  }
  const text = raw.trim();
  const parsed = parseJsonLenient(text);
  if (parsed) {
    return parsed.value;
  }
  if (text === "True" || text === "False") {
    return text === "True";
  }
  if (text === "None") {
    return null;
  }
  return raw;
}

const ARG_PAIR_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)(<\/arg_value>|$)/g;

// Qwen XML parameters, as vLLM reads them: a value ends at </parameter> or,
// when that is missing, at the next <parameter=, </function> or the end.
const QWEN_PARAM_RE =
  /<\s*parameter\s*=\s*([^>]*)>([\s\S]*?)(<\s*\/\s*parameter\s*>|(?=<\s*parameter\s*=)|(?=<\s*\/\s*function\s*>)|$)/g;

// The Qwen template writes "<parameter=KEY>\n" + value + "\n</parameter>", so
// one newline on each side is markup. They are removed as a pair: a value
// written without the leading one ("<parameter=content>a\n</parameter>") has
// no template wrapping, and its trailing newline belongs to the content.
// (vLLM strips each side on its own, which would drop it.)
function trimWrappingNewlines(value) {
  if (!value.startsWith("\n")) {
    return value;
  }
  const inner = value.slice(1);
  return inner.endsWith("\n") ? inner.slice(0, -1) : inner;
}

// Key/value pairs (GLM <arg_key>/<arg_value>, Qwen <parameter=KEY>), values
// converted by schema type. A last value with no closing tag is fine when the
// block itself was closed (the model just skipped the tag), but in a block
// cut off at the end of the stream it is truncated: that is an error, so a
// half-written file is retried rather than returned.
function parseKeyValueArgs(tool, text, { pattern, trim = (value) => value, terminated }) {
  const args = {};
  let found = false;
  for (const match of text.matchAll(pattern)) {
    const key = match[1].trim();
    if (!key) {
      continue;
    }
    if (!terminated && match[3] === "" && match.index + match[0].length === text.length) {
      return { error: `argument "${key}" for "${tool.name}" was cut off` };
    }
    args[key] = convertArgValue(trim(match[2]), tool.parameters?.properties?.[key]);
    found = true;
  }
  return found ? buildToolCall(tool, args) : { error: `no arguments found for "${tool.name}"` };
}

function parseJsonArgs(tool, value) {
  const name = tool.name;
  let args = value ?? {};
  if (typeof args === "string") {
    if (!args.trim()) {
      args = {};
    } else {
      const parsed = parseJsonLenient(args);
      if (!parsed) {
        return { error: `invalid JSON arguments for "${name}"` };
      }
      args = parsed.value;
    }
  }
  if (!isPlainObject(args)) {
    return { error: `arguments for "${name}" are not an object` };
  }
  return buildToolCall(tool, args);
}

// JSON call object: {"name", "arguments"|"parameters"} or the OpenAI shape
// {"function": {"name", "arguments"}}.
function parseJsonCall(body, tools) {
  const parsed = parseJsonLenient(body)?.value;
  if (parsed === undefined) {
    return { error: "invalid JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { error: "not a JSON object" };
  }
  const call = typeof parsed.name !== "string" && isPlainObject(parsed.function) ? parsed.function : parsed;
  if (typeof call.name !== "string") {
    return { error: "missing tool name" };
  }
  const tool = tools.get(call.name);
  if (!tool) {
    return { error: `unknown tool "${call.name}"` };
  }
  return parseJsonArgs(tool, call.arguments ?? call.parameters);
}

// A key tag that runs straight into JSON, as models do when they drift from
// their native format: GLM "write<arg_key>path": "a", "content": "b"}" or Qwen
// "<parameter=path": "a", ...}". Rebuilds the object and parses it leniently.
function parseHybridArgs(tool, text) {
  let body = text.trim();
  const closing = /\s*<\s*\/\s*(?:arg_value|arg_key|parameter|function|tool_call|proxy_call)\s*>$/;
  while (closing.test(body)) {
    body = body.replace(closing, "").trimEnd();
  }
  const json = body.startsWith("{") ? body : body.startsWith('"') ? `{${body}` : `{"${body}`;
  const parsed = parseJsonLenient(json.endsWith("}") ? json : `${json}}`);
  if (!parsed || !isPlainObject(parsed.value)) {
    return { error: `invalid arguments for "${tool.name}"` };
  }
  return buildToolCall(tool, parsed.value);
}

// Whatever follows the tool name: GLM pairs, Qwen parameters, a JSON object,
// or a hybrid of a key tag and JSON.
function parseCallArguments(tool, rest, terminated) {
  if (!rest.trim()) {
    return buildToolCall(tool, {});
  }
  if (rest.startsWith("{")) {
    return parseJsonArgs(tool, rest);
  }
  if (rest.startsWith("<arg_key>")) {
    return rest.includes("</arg_key>")
      ? parseKeyValueArgs(tool, rest, { pattern: ARG_PAIR_RE, terminated })
      : parseHybridArgs(tool, rest.slice("<arg_key>".length));
  }
  const parameter = /^<\s*parameter\s*=\s*([^>]*)>?/.exec(rest);
  if (parameter) {
    // A quote in the "key" means JSON took over after "<parameter=".
    return parameter[1].includes('"')
      ? parseHybridArgs(tool, rest.slice(rest.indexOf("=") + 1))
      : parseKeyValueArgs(tool, rest, { pattern: QWEN_PARAM_RE, trim: trimWrappingNewlines, terminated });
  }
  return { error: `unrecognized arguments for "${tool.name}"` };
}

// Body that starts with the tool name (GLM), or with <function=NAME> (Qwen
// XML, with or without the closing </function>).
function parseNamedCall(body, tools, terminated) {
  const fn = /^<\s*function\s*=\s*([^>\s]+)\s*>\s*/.exec(body);
  const match = fn ?? /^([^\s<{"]+)\s*/.exec(body);
  if (!match) {
    return { error: "missing tool name" };
  }
  const name = match[1];
  const tool = tools.get(name);
  if (!tool) {
    return { error: `unknown tool "${name}"` };
  }
  let rest = body.slice(match[0].length);
  if (fn) {
    const closed = /\s*<\s*\/\s*function\s*>\s*$/.exec(rest);
    if (closed) {
      rest = rest.slice(0, closed.index);
      terminated = true;
    }
  }
  return parseCallArguments(tool, rest, terminated);
}

// Parses the inside of a call block, whatever format the model used.
// `terminated` is false for a block cut off at the end of the stream.
// Returns { toolCall } or { error }.
export function parseCallBody(raw, tools, { terminated = true } = {}) {
  const index = indexTools(tools);
  const body = stripFence(String(raw).trim());
  return body.startsWith("{") ? parseJsonCall(body, index) : parseNamedCall(body, index, terminated);
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
  const parsed = parseJsonLenient(body, { whole: true })?.value;
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
          // apology, a "fixed" retry, a summary) ends the reply. Stray
          // wrapper closers (e.g. </tool_call> after a bare <function=…>)
          // are skipped.
          const trimmed = buffer.trimStart().replace(/^(?:<\/(?:tool_call|proxy_call)>\s*)+/, "");
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

      // mode === "tag"; a bare <function=…> block keeps its tag in the body.
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
        const result = parseCallBody(body, known, { terminated: false });
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

// The conversation for the one retry: the unparsed reply goes back to the
// model with a short correction in its own format.
export function buildRetryMessages(emulation, output, reason) {
  const spec = TOOL_FORMATS[emulation.format] ?? TOOL_FORMATS.json;
  return [
    ...emulation.messages,
    { role: "assistant", content: output },
    {
      role: "user",
      content: `Your last reply contained a tool call that could not be parsed (${reason}). Reply again with only the corrected tool call(s), nothing else, in exactly this format:\n${spec.example}`,
    },
  ];
}

export const DEFAULT_REASONING_BUDGET = 32_000;

// Parses VENICE_TOOL_REASONING_BUDGET: characters of reasoning allowed before
// an answer starts; 0 turns the budget off.
export function parseReasoningBudget(value) {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_REASONING_BUDGET;
  }
  const budget = Number(value.trim());
  return Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_REASONING_BUDGET;
}

const BREVITY_NOTE = "[Keep your reasoning brief: answer or call a tool right away.]";

// Same conversation with a note on the latest user turn. The note goes into
// that turn rather than a new user message: two user turns in a row would
// lose the first one on Venice's chat endpoint.
function withNoteOnLastUserTurn(emulation, note) {
  const messages = [...emulation.messages];
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  if (lastUser !== -1) {
    messages[lastUser] = { ...messages[lastUser], content: `${messages[lastUser].content}\n\n${note}` };
  }
  return messages;
}

// The retry after a reasoning overrun: a nudge to be brief.
export function buildOverrunRetryMessages(emulation) {
  return withNoteOnLastUserTurn(emulation, BREVITY_NOTE);
}

// The retry after an empty reply. Seen live with Qwen 3.5+ on <proxy_call>: the
// model fell back to its native <tool_call>, which Venice strips upstream, so
// nothing arrived. The note repeats the format the model must use.
export function buildEmptyRetryMessages(emulation) {
  const spec = TOOL_FORMATS[emulation.format] ?? TOOL_FORMATS.json;
  const tag = spec.tag ?? "tool_call";
  return withNoteOnLastUserTurn(
    emulation,
    `[Your last reply arrived empty: any tool call in it did not come through. Answer, or call a tool in exactly this format, with <${tag}> tags:\n${spec.example}]`,
  );
}

// Runs one emulated completion. openAttempt(messages) returns an async
// iterable of upstream events { type: "meta" | "reasoning" | "content" };
// leaving it early must cancel the upstream request. Yields client events
// { type: "meta" | "reasoning" | "text" | "tool_call" | "error" }.
//
// Reading stops as soon as the reply is complete, so the model cannot go on
// with "let me fix that". One retry covers two failures, before anything
// about them reaches the client:
// - an unparsed call block (before any call): the model gets its raw reply
//   back with a correction; text from that retry is not shown, and if it fails
//   too the original block comes back as text;
// - a reasoning overrun: more than reasoningBudget characters of reasoning
//   before any answer text or call. The request is cancelled and asked again
//   with a nudge to be brief; if that overruns as well, an "error" event ends
//   the reply instead of waiting for the upstream timeout.
// onEvent reports "retry", "overrun", "failed" and "dropped" for logging.
export async function* runToolEmulation({
  emulation,
  openAttempt,
  onEvent = () => {},
  stats = {},
  reasoningBudget = DEFAULT_REASONING_BUDGET,
}) {
  stats.attempts = 0;
  stats.toolCalls = 0;
  let messages = emulation.messages;
  let firstFailure = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retrying = attempt > 0;
    // Text from a correction retry is hidden; after an overrun or an empty
    // reply nothing was answered yet, so the retry's text is the answer.
    const showText = !retrying || firstFailure?.overrun || firstFailure?.empty;
    stats.attempts = attempt + 1;
    const parser = createToolCallParser(emulation.tools, { maxCalls: emulation.maxCalls });
    let output = "";
    let reasoningChars = 0;
    let answerStarted = false;
    let failure = null;
    let finished = false;

    // Whitespace-only text is held until real text follows, so an empty
    // reply that gets retried sends nothing.
    let blank = "";

    // Applies parser events and returns the ones the client should see.
    const apply = (events) => {
      const visible = [];
      for (const event of events) {
        if (finished || failure) {
          break;
        }
        if (event.type === "text") {
          if (!event.text.trim()) {
            blank += event.text;
          } else if (showText) {
            visible.push({ type: "text", text: blank + event.text });
            blank = "";
          }
        } else if (event.type === "tool_call") {
          stats.toolCalls += 1;
          visible.push(event);
        } else if (event.type === "stop") {
          finished = true;
        } else if (event.type === "invalid") {
          if (stats.toolCalls > 0) {
            onEvent({ type: "dropped", reason: event.reason, outputs: [output] });
            finished = true;
          } else {
            failure = event;
          }
        }
      }
      return visible;
    };

    for await (const event of openAttempt(messages)) {
      if (event.type === "content") {
        output += event.text;
        answerStarted ||= event.text.trim() !== "";
        yield* apply(parser.push(event.text));
        if (finished || failure) {
          break;
        }
      } else if (event.type === "reasoning") {
        yield event;
        if (!answerStarted && reasoningBudget > 0) {
          reasoningChars += event.text.length;
          if (reasoningChars > reasoningBudget) {
            failure = {
              overrun: true,
              reason: `reasoning passed ${reasoningBudget} characters without an answer`,
              raw: "",
            };
            break;
          }
        }
      } else if (event.type === "meta" && !retrying) {
        yield event;
      }
    }
    if (!finished && !failure) {
      yield* apply(parser.end());
    }

    if (stats.toolCalls > 0) {
      return;
    }
    const empty = !failure && !output.trim();
    if (!failure && !empty && blank && showText) {
      // Trailing whitespace of a real answer.
      yield { type: "text", text: blank };
    }
    if (!failure && !empty) {
      if (!retrying || firstFailure.overrun || firstFailure.empty) {
        return;
      }
      failure = { reason: "the retry contained no tool call", raw: output };
    }
    if (empty && !retrying) {
      failure = { empty: true, reason: "the reply was empty", raw: "" };
    } else if (empty) {
      // Nothing arrived twice: report it and end with the empty reply.
      onEvent({ type: "failed", reason: `${firstFailure.reason}; retry: the reply was empty`, outputs: [firstFailure.output].filter(Boolean) });
      if (blank && showText) {
        yield { type: "text", text: blank };
      }
      return;
    }
    if (!retrying) {
      firstFailure = { ...failure, output };
      if (failure.overrun) {
        onEvent({ type: "overrun", reason: failure.reason, outputs: [] });
        messages = buildOverrunRetryMessages(emulation);
      } else if (failure.empty) {
        onEvent({ type: "empty", reason: failure.reason, outputs: [] });
        messages = buildEmptyRetryMessages(emulation);
      } else {
        onEvent({ type: "retry", reason: failure.reason, outputs: [output] });
        messages = buildRetryMessages(emulation, output, failure.reason);
      }
      continue;
    }
    onEvent({
      type: "failed",
      reason: `${firstFailure.reason}; retry: ${failure.reason}`,
      outputs: [firstFailure.output, output].filter(Boolean),
    });
    const fallback = firstFailure.raw || failure.raw;
    if (fallback) {
      yield { type: "text", text: fallback };
    } else {
      yield {
        type: "error",
        code: "reasoning_budget_exceeded",
        message: `The model kept reasoning past ${reasoningBudget} characters without answering, twice; the request was stopped instead of waiting for the upstream timeout. Set VENICE_TOOL_REASONING_BUDGET to change the limit (0 disables it).`,
      };
    }
    return;
  }
}
