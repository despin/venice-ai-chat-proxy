import { pathToFileURL } from "node:url";
import {
  buildToolCallDeltas,
  buildToolSystemPrompt,
  createToolCallParser,
  injectToolPrompt,
  normalizeTools,
  parseJsonLenient,
  parseToolCalls,
  parseToolEmulationSetting,
  renderHistoryWithTools,
  parseToolFormatRules,
  resolveToolEmulation,
  resolveToolFormat,
  TOOL_FORMAT_NAMES,
  appendToolReminder,
  buildEmptyRetryMessages,
  buildRetryMessages,
  DEFAULT_REASONING_BUDGET,
  parseReasoningBudget,
  runToolEmulation,
  toolFormatReminder,
} from "../src/tool-emulation.mjs";
import { parseJsonLineStream, parseSseStream as parseClientSseStream } from "../src/client.mjs";
import { describeFirstDifference } from "./tools.mjs";
import {
  OPENCODE_SYSTEM_PROMPT,
  OPENCODE_TASK,
  OPENCODE_TOOLS,
  OPENCODE_WRITE_CONTENT,
  OPENCODE_WRITE_CONTENT_BLANK_END,
  OPENCODE_WRITE_PATH,
  opencodeTask,
} from "./opencode-fixture.mjs";
import {
  createVeniceOpenAiProxy,
  createVeniceOpenAiProxyServer,
} from "../src/proxy.mjs";

// Offline checks for prompt-based tool calling: the pure helpers, then the
// proxy wiring against a stubbed Venice client on a loopback port.

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

const TOOL_NAMES = ["read_file", "get_weather"];

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};
const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
};

function feed(text, { chunkSize = text.length || 1, ...options } = {}) {
  const warnings = [];
  const parser = createToolCallParser(TOOL_NAMES, {
    ...options,
    onWarning: (warning) => warnings.push(warning),
  });
  const events = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    events.push(...parser.push(text.slice(index, index + chunkSize)));
  }
  events.push(...parser.end());
  return {
    text: events.filter((event) => event.type === "text").map((event) => event.text).join(""),
    calls: events.filter((event) => event.type === "tool_call").map((event) => event.toolCall),
    warnings,
    events,
  };
}

function parse(text) {
  const warnings = [];
  const result = parseToolCalls(text, TOOL_NAMES, { onWarning: (warning) => warnings.push(warning) });
  return { ...result, warnings };
}

function args(call) {
  return JSON.parse(call.function.arguments);
}

// ──────────────────────────────────────────────
// Parser
// ──────────────────────────────────────────────

function testParser() {
  section("parseToolCalls");

  const single = parse('<tool_call>{"name": "read_file", "arguments": {"path": "src/a.js"}}</tool_call>');
  ok("single call parsed", single.toolCalls.length === 1);
  ok("call id has call_ prefix", /^call_[0-9a-f]{24}$/.test(single.toolCalls[0]?.id ?? ""));
  ok("type is function", single.toolCalls[0]?.type === "function");
  ok("arguments is a JSON string", typeof single.toolCalls[0]?.function.arguments === "string");
  ok("arguments round-trip", args(single.toolCalls[0]).path === "src/a.js");
  ok("content null when only a call", single.content === null);

  const multiple = parse(
    '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>\n<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>',
  );
  ok("multiple calls parsed in order",
    multiple.toolCalls.map((call) => call.function.name).join(",") === "read_file,get_weather");
  ok("multiple calls get distinct ids", multiple.toolCalls[0]?.id !== multiple.toolCalls[1]?.id);

  const withText = parse('Let me check.\n\n<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>\nDone!');
  ok("text before call becomes content", withText.content === "Let me check.");
  ok("text after call is dropped", !String(withText.content).includes("Done"));

  const asString = parse('<tool_call>{"name":"get_weather","arguments":"{\\"city\\":\\"Rome\\"}"}</tool_call>');
  ok("arguments given as JSON string", asString.toolCalls.length === 1 && args(asString.toolCalls[0]).city === "Rome");

  const alias = parse('<tool_call>{"name":"get_weather","parameters":{"city":"Oslo"}}</tool_call>');
  ok("parameters accepted as alias", alias.toolCalls.length === 1 && args(alias.toolCalls[0]).city === "Oslo");

  const fencedInside = parse('<tool_call>\n```json\n{"name":"get_weather","arguments":{"city":"Kyiv"}}\n```\n</tool_call>');
  ok("fence inside tags stripped", fencedInside.toolCalls.length === 1 && args(fencedInside.toolCalls[0]).city === "Kyiv");

  const spacedTag = parse('<tool_call >  {"name":"get_weather","arguments":{}}  </tool_call>');
  ok("whitespace in tag and body tolerated", spacedTag.toolCalls.length === 1);
  ok("missing arguments become {}", spacedTag.toolCalls[0]?.function.arguments === "{}");

  const malformedText = 'Sure <tool_call>{"name": "read_file", "arguments": {"path": }</tool_call>';
  const malformed = parse(malformedText);
  ok("malformed JSON yields no call", malformed.toolCalls.length === 0);
  ok("malformed JSON returns raw text", malformed.content === malformedText);
  ok("malformed JSON warns", malformed.warnings.length === 1 && /invalid JSON/.test(malformed.warnings[0].reason));

  const unknownText = '<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>';
  const unknown = parse(unknownText);
  ok("unknown tool yields no call", unknown.toolCalls.length === 0);
  ok("unknown tool returns raw text", unknown.content === unknownText);
  ok("unknown tool warns with name", /unknown tool "delete_everything"/.test(unknown.warnings[0]?.reason ?? ""));

  const badArgs = parse('<tool_call>{"name":"get_weather","arguments":"not json"}</tool_call>');
  ok("non-JSON string arguments rejected", badArgs.toolCalls.length === 0 && badArgs.warnings.length === 1);

  const plain = "The weather tool is not needed; it is sunny. Use <b>bold</b> and a < b.";
  const none = parse(plain);
  ok("no call: content unchanged", none.content === plain && none.toolCalls.length === 0);
  ok("no call: no warnings", none.warnings.length === 0);

  const fenced = parse('```json\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n```');
  ok("fenced JSON fallback", fenced.toolCalls.length === 1 && args(fenced.toolCalls[0]).city === "Paris");

  const bare = parse('  {"name": "read_file", "arguments": {"path": "x"}}\n');
  ok("bare JSON fallback", bare.toolCalls.length === 1 && bare.content === null);

  const jsonAnswerText = '{"name": "Alice", "age": 30}';
  const jsonAnswer = parse(jsonAnswerText);
  ok("ordinary JSON answer is not a call", jsonAnswer.toolCalls.length === 0 && jsonAnswer.content === jsonAnswerText);
  ok("ordinary JSON answer does not warn", jsonAnswer.warnings.length === 0);

  const fencedWithText = parse('Here:\n```json\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n```');
  ok("fallback needs the whole reply", fencedWithText.toolCalls.length === 0);

  const unterminated = parse('<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}');
  ok("unterminated but parsable block becomes a call", unterminated.toolCalls.length === 1);

  const truncatedText = 'Ok <tool_call>{"name":"read_file","arguments":{"path":"src/very/long';
  const truncated = parse(truncatedText);
  ok("truncated block flushed as text", truncated.toolCalls.length === 0 && truncated.content === truncatedText);
  ok("truncated block warns", /unterminated/.test(truncated.warnings[0]?.reason ?? ""));

  const notATag = parse("Use <tool_calls> or <tool_caller> freely.");
  ok("look-alike tags stay text", notATag.toolCalls.length === 0 && notATag.content === "Use <tool_calls> or <tool_caller> freely.");

  const capped = parseToolCalls(
    '<tool_call>{"name":"read_file","arguments":{}}</tool_call><tool_call>{"name":"get_weather","arguments":{}}</tool_call>',
    TOOL_NAMES,
    { maxCalls: 1 },
  );
  ok("maxCalls keeps only the first call", capped.toolCalls.length === 1 && capped.toolCalls[0].function.name === "read_file");

  const openAiShape = parse('<tool_call>{"function":{"name":"get_weather","arguments":"{\\"city\\":\\"Lima\\"}"}}</tool_call>');
  ok("OpenAI-shaped body accepted", openAiShape.toolCalls.length === 1 && args(openAiShape.toolCalls[0]).city === "Lima");
}

function testStreamingParser() {
  section("createToolCallParser — streaming");

  const reply = 'Checking the file.\n<tool_call>{"name": "read_file", "arguments": {"path": "src/a.js"}}</tool_call>\nAnd then some trailing text.';
  const whole = feed(reply);
  const byChar = feed(reply, { chunkSize: 1 });
  ok("one char at a time: one call", byChar.calls.length === 1);
  ok("one char at a time: same text as whole", byChar.text === whole.text && byChar.text === "Checking the file.");
  ok("one char at a time: same arguments", byChar.calls[0]?.function.arguments === whole.calls[0]?.function.arguments);
  ok("text before call streamed before the call",
    byChar.events.findIndex((event) => event.type === "tool_call") > 0);

  for (const size of [2, 3, 5, 7, 11]) {
    const chunked = feed(reply, { chunkSize: size });
    ok(`chunk size ${size}: identical result`, chunked.text === whole.text && chunked.calls.length === 1);
  }

  const parser = createToolCallParser(TOOL_NAMES);
  const first = parser.push("Hi <to");
  ok("partial tag held back", first.map((event) => event.text).join("") === "Hi");
  const second = parser.push('ol_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>');
  ok("split tag completes into a call", second.length === 1 && second[0].type === "tool_call");
  ok("parser counts the call", parser.toolCallCount === 1);
  const afterCall = [...parser.push(" extra words"), ...parser.end()];
  ok("text after a call stops the reply",
    afterCall.length === 1 && afterCall[0].type === "stop");
  ok("nothing after stop", parser.push("<tool_call>").length === 0 && parser.end().length === 0);

  const textParser = createToolCallParser(TOOL_NAMES);
  const held = textParser.push("a <tool");
  ok("ambiguous prefix held", held.map((event) => event.text).join("") === "a");
  const released = [...textParser.push("box> b"), ...textParser.end()];
  ok("disproven prefix flushed as text", released.map((event) => event.text).join("") === " <toolbox> b");

  const lossless = "  Line one.\n\nLine two <tool  and  \n\n";
  ok("no call: streamed text is lossless", feed(lossless, { chunkSize: 1 }).text === lossless);

  const leading = feed('\n\n<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>\n', { chunkSize: 1 });
  ok("call-only reply streams no stray whitespace", leading.text === "" && leading.calls.length === 1);

  const python = createToolCallParser(TOOL_NAMES);
  const pythonOut = python.push("```python\nprint(1)\n");
  ok("```python answer is not held for the fallback", pythonOut.map((event) => event.text).join("").startsWith("```python"));

  const jsonHold = createToolCallParser(TOOL_NAMES);
  ok("reply starting with { is held", jsonHold.push('{"name": "get_weather", ').length === 0);
  const jsonEnd = [...jsonHold.push('"arguments": {"city": "Paris"}}'), ...jsonHold.end()];
  ok("held JSON resolves to a call at end", jsonEnd.length === 1 && jsonEnd[0].type === "tool_call");

  const fencedByChar = feed('```json\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n```', { chunkSize: 1 });
  ok("fenced fallback works char by char", fencedByChar.calls.length === 1 && fencedByChar.text === "");

  const heldTagged = feed('{"note": 1}\n<tool_call>{"name":"get_weather","arguments":{}}</tool_call>', { chunkSize: 4 });
  ok("held reply with a tag still yields the call", heldTagged.calls.length === 1 && heldTagged.text === '{"note": 1}');

  const deltas = buildToolCallDeltas(
    { id: "call_x", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
    2,
  );
  ok("first delta opens the call with id, type and name",
    JSON.stringify(deltas[0]) ===
      '{"tool_calls":[{"index":2,"id":"call_x","type":"function","function":{"name":"get_weather","arguments":""}}]}');
  ok("second delta carries the arguments",
    JSON.stringify(deltas[1]) === '{"tool_calls":[{"index":2,"function":{"arguments":"{\\"city\\":\\"Paris\\"}"}}]}');
}

// ──────────────────────────────────────────────
// History rendering, prompt and activation
// ──────────────────────────────────────────────

function testHistory() {
  section("renderHistoryWithTools");

  const rendered = renderHistoryWithTools([
    { role: "system", content: "Be brief." },
    { role: "user", content: "Weather in Paris and Rome?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        { id: "call_2", type: "function", function: { name: "get_weather", arguments: '{"city":"Rome"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "18C rain" },
    { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "25C sun" }] },
    { role: "assistant", content: "Paris 18C, Rome 25C." },
    { role: "user", content: "Thanks" },
  ]);

  ok("roles alternate after merging",
    rendered.map((message) => message.role).join(",") === "system,user,assistant,user,assistant,user");
  const calls = rendered[2]?.content ?? "";
  ok("assistant with null content and tool_calls is kept", calls.includes("<tool_call>"));
  ok("assistant renders one block per call", (calls.match(/<tool_call>/g) ?? []).length === 2);
  ok("rendered call uses original name and arguments",
    calls.includes('<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>'));
  const results = rendered[3]?.content ?? "";
  ok("tool results merged into one user message",
    results.includes('<tool_result name="get_weather" id="call_1">18C rain</tool_result>') &&
      results.includes('<tool_result name="get_weather" id="call_2">25C sun</tool_result>'));
  ok("rendered history round-trips through the parser",
    parseToolCalls(calls, TOOL_NAMES).toolCalls.length === 2);

  const withText = renderHistoryWithTools([
    { role: "user", content: "hi" },
    { role: "assistant", content: "Let me look.", tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "missing", name: "legacy_name", content: "x" },
    { role: "tool", tool_call_id: "missing2", content: "y" },
  ]);
  ok("assistant text precedes its calls", withText[1]?.content.startsWith("Let me look.\n\n<tool_call>"));
  ok("unresolved id falls back to message.name", withText[2]?.content.includes('name="legacy_name"'));
  ok("unresolved id without name uses unknown", withText[2]?.content.includes('name="unknown"'));

  const reasoning = renderHistoryWithTools([
    { role: "user", content: "a" },
    { role: "assistant", content: null, reasoning_content: "[__vc_hist__]e30=[/__vc_hist__]" },
    { role: "assistant", content: "b" },
  ]);
  ok("assistant reasoning_content preserved and not merged",
    reasoning.length === 3 && reasoning[1].reasoning_content?.startsWith("[__vc_hist__]"));

  section("injectToolPrompt / buildToolSystemPrompt");

  const injected = injectToolPrompt(
    [{ role: "system", content: "A" }, { role: "system", content: "B" }, { role: "user", content: "u" }],
    "TOOLS",
  );
  ok("appended to the last leading system message",
    injected[1].content === "B\n\nTOOLS" && injected[0].content === "A" && injected.length === 3);
  const late = injectToolPrompt(
    [{ role: "system", content: "A" }, { role: "user", content: "u" }, { role: "system", content: "Z" }],
    "TOOLS",
  );
  ok("appended to the last system message, wherever it is",
    late[0].content === "A" && late[2].content === "Z\n\nTOOLS");
  const reminded = appendToolReminder(
    [{ role: "user", content: "q" }, { role: "assistant", content: "a" }, { role: "user", content: "r" }, { role: "assistant", content: "x" }],
    "glm",
  );
  ok("reminder goes on the latest user turn only",
    reminded[0].content === "q" && reminded[2].content === `r\n\n${toolFormatReminder("glm")}` && reminded[3].content === "x");
  ok("reminder is one line naming the format",
    !toolFormatReminder("glm").includes("\n") && toolFormatReminder("glm").includes("<arg_key>"));
  const inserted = injectToolPrompt([{ role: "user", content: "u" }], "TOOLS");
  ok("system message inserted when none", inserted[0].role === "system" && inserted[0].content === "TOOLS");

  const tools = [WEATHER_TOOL, READ_FILE_TOOL];
  const auto = buildToolSystemPrompt(tools, "auto");
  ok("prompt lists tool names", auto.includes("### get_weather") && auto.includes("### read_file"));
  ok("prompt includes descriptions", auto.includes("Get the current weather for a city."));
  ok("prompt includes compact schema", auto.includes('{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}'));
  ok("prompt shows the tag format", auto.includes('<tool_call>{"name": "TOOL_NAME"'));
  ok("prompt mentions tool_result", auto.includes("<tool_result"));
  ok("auto allows plain answers", auto.includes("If no tool is needed"));
  ok("required forces a call", buildToolSystemPrompt(tools, "required").includes("must call at least one tool"));
  ok("named choice forces that tool",
    buildToolSystemPrompt(tools, { type: "function", function: { name: "read_file" } }).includes('must call the tool "read_file"'));
  ok("named choice for an unknown tool falls back to auto",
    buildToolSystemPrompt(tools, { type: "function", function: { name: "nope" } }).includes("If no tool is needed"));
  ok("parallel_tool_calls:false limits to one call",
    buildToolSystemPrompt(tools, "auto", { parallel: false }).includes("at most one tool"));

  section("resolveToolEmulation");

  const messages = [{ role: "user", content: "hi" }];
  ok("no tools → null", resolveToolEmulation({ messages }) === null);
  ok("empty tools → null", resolveToolEmulation({ messages, tools: [] }) === null);
  ok("invalid tools → null", resolveToolEmulation({ messages, tools: [{ type: "web_search" }, { type: "function" }] }) === null);
  ok("tool_choice none → null", resolveToolEmulation({ messages, tools, tool_choice: "none" }) === null);
  ok("disabled → null", resolveToolEmulation({ messages, tools }, { enabled: false }) === null);
  const active = resolveToolEmulation({ messages, tools, tool_choice: "required", parallel_tool_calls: false });
  ok("active: tool names", active?.toolNames.join(",") === "get_weather,read_file");
  ok("active: choice label", active?.toolChoiceLabel === "required");
  ok("active: maxCalls 1 without parallel calls", active?.maxCalls === 1);
  ok("active: system prompt injected", active?.messages[0].role === "system" && active.messages[0].content.startsWith("# Tools"));
  ok("active: reminder on the last user turn", active?.messages.at(-1).content === `hi\n\n${toolFormatReminder("json")}`);
  ok("named choice label",
    resolveToolEmulation({ messages, tools, tool_choice: { type: "function", function: { name: "get_weather" } } })
      ?.toolChoiceLabel === "function:get_weather");

  ok("env default is on", parseToolEmulationSetting(undefined) === true && parseToolEmulationSetting("on") === true);
  ok("env off values", ["off", "0", "false", "NO", " Off "].every((value) => parseToolEmulationSetting(value) === false));
}

function testFormats() {
  section("tool formats");

  ok("glm models get the glm format", resolveToolFormat("zai-org-glm-5-2") === "glm");
  ok("model suffix does not matter", resolveToolFormat("zai-org-glm-5-2:webEnabled=true") === "glm");
  ok("qwen models get the qwen format", resolveToolFormat("qwen3-235b-a22b") === "qwen");
  ok("other models get json", resolveToolFormat("deepseek-v4-1-flash-free") === "json");
  const { rules, invalid } = parseToolFormatRules("glm=json, kimi=qwen ,bad, x=nope,*=glm");
  ok("env rules parsed", rules.length === 3 && invalid.join("|") === "bad|x=nope");
  ok("env rule overrides default", resolveToolFormat("zai-org-glm-5-2", rules) === "json");
  ok("env rule adds a family", resolveToolFormat("kimi-k2-5", rules) === "qwen");
  ok("* matches everything else", resolveToolFormat("llama", rules) === "glm");

  const tools = [WEATHER_TOOL, READ_FILE_TOOL];
  const glmPrompt = buildToolSystemPrompt(tools, "auto", { format: "glm" });
  ok("glm prompt uses the native template wording",
    glmPrompt.includes("For each function call, output the function name and arguments within the following XML format:") &&
      glmPrompt.includes("<tools>\n{\"type\":\"function\",\"function\":{\"name\":\"get_weather\""));
  ok("glm prompt explains raw string values", glmPrompt.includes("no surrounding quotes and no escaping"));
  ok("glm prompt names tool_response", glmPrompt.includes("<tool_response>"));
  const qwenPrompt = buildToolSystemPrompt(tools, "required", { format: "qwen" });
  ok("qwen prompt uses the native template wording",
    qwenPrompt.includes('{"name": <function-name>, "arguments": <args-json-object>}') &&
      qwenPrompt.includes("must call at least one tool"));

  const history = [
    { role: "user", content: "Write it" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "c1",
        type: "function",
        function: { name: "write", arguments: JSON.stringify({ path: "a.md", content: "# A\n\"q\" \\ end\n", mode: 420, force: true }) },
      }],
    },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];
  const glmHistory = renderHistoryWithTools(history, { format: "glm" });
  ok("glm history renders native pairs",
    glmHistory[1].content ===
      '<tool_call>write\n<arg_key>path</arg_key>\n<arg_value>a.md</arg_value>\n<arg_key>content</arg_key>\n<arg_value># A\n"q" \\ end\n</arg_value>\n<arg_key>mode</arg_key>\n<arg_value>420</arg_value>\n<arg_key>force</arg_key>\n<arg_value>true</arg_value>\n</tool_call>');
  ok("glm history renders tool_response", glmHistory[2].content === "<tool_response>\nok\n</tool_response>");
  const qwenHistory = renderHistoryWithTools(history, { format: "qwen" });
  ok("qwen history renders native JSON block", qwenHistory[1].content.startsWith('<tool_call>\n{"name": "write", "arguments": {"path":"a.md"'));

  const writeTool = {
    name: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "integer" },
        force: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        note: { type: ["string", "null"] },
      },
    },
  };
  for (const format of TOOL_FORMAT_NAMES) {
    const rendered = renderHistoryWithTools(history, { format })[1].content;
    const parsed = parseToolCalls(rendered, [writeTool]);
    ok(`${format}: rendered history parses back to the same arguments`,
      parsed.toolCalls.length === 1 &&
        parsed.toolCalls[0].function.arguments === history[1].tool_calls[0].function.arguments,
      parsed.toolCalls[0]?.function.arguments);
  }

  const native = parseToolCalls(
    "<tool_call>write\n<arg_key>path</arg_key>\n<arg_value>src/x.js</arg_value>\n<arg_key>mode</arg_key>\n<arg_value>7</arg_value>\n<arg_key>tags</arg_key>\n<arg_value>[\"a\",\"b\"]</arg_value>\n<arg_key>force</arg_key>\n<arg_value>True</arg_value>\n<arg_key>note</arg_key>\n<arg_value>123</arg_value>\n<arg_key>content</arg_key>\n<arg_value>42</arg_value>\n</tool_call>",
    [writeTool],
  );
  const nativeArgs = native.toolCalls[0] ? args(native.toolCalls[0]) : {};
  ok("glm native: string-typed values stay strings", nativeArgs.path === "src/x.js" && nativeArgs.content === "42" && nativeArgs.note === "123");
  ok("glm native: typed values converted by schema",
    nativeArgs.mode === 7 && nativeArgs.force === true && nativeArgs.tags?.join(",") === "a,b");
  const unknownKey = parseToolCalls("<tool_call>get_weather<arg_key>city</arg_key><arg_value>Paris</arg_value><arg_key>days</arg_key><arg_value>3</arg_value></tool_call>", [WEATHER_TOOL.function]);
  ok("glm native: unknown keys read as JSON when possible",
    unknownKey.toolCalls[0] && args(unknownKey.toolCalls[0]).days === 3 && args(unknownKey.toolCalls[0]).city === "Paris");
  ok("glm native: name with JSON args object",
    parseToolCalls('<tool_call>get_weather\n{"city": "Oslo"}</tool_call>', TOOL_NAMES).toolCalls.length === 1);
}

// Real GLM 5.2 outputs logged from opencode sessions: native and JSON formats
// mixed. Each must come back as write() with the right path and content.
function testLoggedFixtures() {
  section("logged GLM fixtures");

  const writeTool = {
    name: "write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  };
  const tools = [writeTool, { name: "read", parameters: null }];
  const check = (label, text, expected) => {
    for (const [mode, result] of [
      ["whole", parseToolCalls(text, tools)],
      ["char by char", (() => {
        const parser = createToolCallParser(tools);
        const events = [];
        for (const char of text) {
          events.push(...parser.push(char));
        }
        events.push(...parser.end());
        return { toolCalls: events.filter((event) => event.type === "tool_call").map((event) => event.toolCall) };
      })()],
    ]) {
      const call = result.toolCalls[0];
      const parsed = call ? args(call) : {};
      ok(`${label} (${mode}): write() with path and content`,
        result.toolCalls.length === 1 && call.function.name === "write" &&
          parsed.path === expected.path && parsed.content === expected.content,
        JSON.stringify(result.toolCalls));
    }
  };

  // 1) hybrid: name + <arg_key> + JSON body, closed with </arg_value></tool_call>.
  check(
    "snippet 1, raw newline",
    '<tool_call>write<arg_key>path": "/root/venice-ai-chat-proxy/test.md", "content": "# Test\n"}</arg_value></tool_call>',
    { path: "/root/venice-ai-chat-proxy/test.md", content: "# Test\n" },
  );
  check(
    "snippet 1, escaped newline",
    '<tool_call>write<arg_key>path": "/root/venice-ai-chat-proxy/test.md", "content": "# Test\\n"}</arg_value></tool_call>',
    { path: "/root/venice-ai-chat-proxy/test.md", content: "# Test\n" },
  );

  // 2) the same, then an apology and another malformed call in the same stream.
  const snippet2 =
    '<tool_call>write<arg_key>path": "/root/venice-ai-chat-proxy/test.md", "content": "# Test\n"}</arg_value></tool_call>' +
    "\nI made a mistake with the tool call format. Let me fix that.\n" +
    '<tool_call>write<arg_key>path</arg_key><arg_value>/root/venice-ai-chat-proxy/test.md"</tool_call>';
  check("snippet 2", snippet2, { path: "/root/venice-ai-chat-proxy/test.md", content: "# Test\n" });
  ok("snippet 2: apology text not returned", parseToolCalls(snippet2, tools).content === null);

  // 3) raw newlines inside the JSON string, no closing tag (stream ended).
  check(
    "snippet 3",
    '<tool_call>write<arg_key>path": "/root/orchestra/test.md", "content": "# Test\n\nThis is a test file.\n"}          ',
    { path: "/root/orchestra/test.md", content: "# Test\n\nThis is a test file.\n" },
  );

  const warnings = [];
  const missing = parseToolCalls('<tool_call>{"name": "get_weather", "arguments": {}}</tool_call>', [WEATHER_TOOL.function], {
    onWarning: (warning) => warnings.push(warning),
  });
  ok("missing required argument is not a call",
    missing.toolCalls.length === 0 && /missing required argument "city"/.test(warnings[0]?.reason ?? ""));

  section("lenient JSON");
  ok("raw newline and tab inside a string", parseJsonLenient('{"a": "x\ny\tz"}')?.value.a === "x\ny\tz");
  ok("escapes stay escapes", parseJsonLenient('{"a": "x\\ny \\"q\\" \\\\"}')?.value.a === 'x\ny "q" \\');
  ok("trailing junk dropped", parseJsonLenient('{"a": 1}</arg_value>\n')?.value.a === 1);
  ok("braces inside strings ignored", parseJsonLenient('{"a": "}{"} tail')?.value.a === "}{");
  ok("hopeless input → null", parseJsonLenient('{"a": ') === null);
  ok("JSON call with raw newlines in the tag",
    parseToolCalls('<tool_call>{"name": "write", "arguments": {"path": "p", "content": "l1\nl2"}}</tool_call>', tools)
      .toolCalls[0]?.function.arguments === '{"path":"p","content":"l1\\nl2"}');
  ok("hybrid with leading quote", parseToolCalls('<tool_call>write<arg_key>"path": "p", "content": "c"}</tool_call>', tools).toolCalls.length === 1);
}

// Qwen3-Coder / Qwen3.5+ XML calls: <function=NAME><parameter=KEY>VALUE…
function testQwenXml() {
  section("qwen XML format (Qwen3-Coder, Qwen3.5+)");

  const formats = {
    "qwen3-coder-480b-a35b-instruct-turbo": "json",
    "qwen-3-8-27b": "proxy",
    "qwen3.8-flash-next": "proxy",
    "qwen3-6-27b": "proxy",
    "qwen3-5-35b-a3b": "proxy",
    "e2ee-qwen3-6-35b-a3b": "proxy",
    "qwen3-vl-235b-a22b": "qwen",
    "qwen3-235b-a22b-instruct-2507": "qwen",
    "qwen3-8b": "qwen",
  };
  for (const [model, format] of Object.entries(formats)) {
    ok(`${model} → ${format}`, resolveToolFormat(model) === format, resolveToolFormat(model));
  }
  ok("env rule can name the new formats", resolveToolFormat("kimi-k2-6", parseToolFormatRules("kimi=qwen-xml").rules) === "qwen-xml");

  const fileTool = {
    name: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path" },
        content: { type: "string" },
        mode: { type: "integer" },
        force: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  };
  const tools = [fileTool, { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }];
  const openAiTools = tools.map((tool) => ({ type: "function", function: tool }));
  const content = 'line "one"\n  C:\\\\dir\\\\file\n\tend\n';

  const xmlPrompt = buildToolSystemPrompt(openAiTools, "auto", { format: "qwen-xml" });
  ok("qwen-xml prompt: template wording and JSON tool lines",
    xmlPrompt.startsWith("# Tools\n\nYou have access to the following functions:\n\n<tools>\n{\"type\":\"function\"") &&
      xmlPrompt.includes("If you choose to call a function ONLY reply in the following format with NO suffix:") &&
      xmlPrompt.includes("<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>") &&
      xmlPrompt.includes("- Required parameters MUST be specified"));
  ok("qwen-xml prompt: values raw, without the over-specified escaping rule",
    xmlPrompt.includes("Write each parameter value exactly as it is") && !xmlPrompt.includes("real line break"));
  const coderPrompt = buildToolSystemPrompt(openAiTools, "auto", { format: "qwen-coder" });
  ok("qwen-coder prompt: tools listed as XML like the Coder template",
    coderPrompt.includes("<tools>\n<function>\n<name>write</name>\n<parameters>\n<parameter>\n<name>path</name>\n<type>string</type>\n<description>Absolute path</description>\n</parameter>") &&
      coderPrompt.includes('<required>["path","content"]</required>') &&
      coderPrompt.includes("<additionalProperties>False</additionalProperties>\n</parameters>\n</function>"));

  const history = renderHistoryWithTools(
    [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "Writing.",
        tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "/a.md", mode: 420 }) } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
    { format: "qwen-xml" },
  );
  ok("qwen-xml history matches the template",
    history[1].content ===
      "Writing.\n\n<tool_call>\n<function=write>\n<parameter=path>\n/a.md\n</parameter>\n<parameter=mode>\n420\n</parameter>\n</function>\n</tool_call>");
  ok("qwen-xml results as tool_response", history[2].content === "<tool_response>\nok\n</tool_response>");

  const parse = (text, options) => {
    const warnings = [];
    const result = parseToolCalls(text, tools, { ...options, onWarning: (warning) => warnings.push(warning) });
    return { ...result, warnings, args: result.toolCalls[0] ? args(result.toolCalls[0]) : null };
  };
  const charByChar = (text) => {
    const parser = createToolCallParser(tools);
    const events = [];
    for (const char of text) {
      events.push(...parser.push(char));
    }
    events.push(...parser.end());
    return events;
  };
  const canonical =
    "Let me write it.\n<tool_call>\n<function=write>\n<parameter=path>\n/tmp/a.txt\n</parameter>\n" +
    `<parameter=content>\n${content}\n</parameter>\n<parameter=mode>\n420\n</parameter>\n` +
    "<parameter=force>\nTrue\n</parameter>\n<parameter=tags>\n[\"x\", \"y\"]\n</parameter>\n</function>\n</tool_call>";
  const parsed = parse(canonical);
  ok("canonical: one write() call, text before it", parsed.toolCalls.length === 1 && parsed.content === "Let me write it.");
  ok("canonical: one wrapping newline trimmed, content exact", parsed.args?.path === "/tmp/a.txt" && parsed.args?.content === content);
  ok("canonical: values converted by schema (incl. Coder's True)",
    parsed.args?.mode === 420 && parsed.args?.force === true && parsed.args?.tags?.join() === "x,y");
  const streamed = charByChar(canonical).filter((event) => event.type === "tool_call");
  ok("canonical: same result one character at a time",
    streamed.length === 1 && streamed[0].toolCall.function.arguments === parsed.toolCalls[0].function.arguments);

  const extraNewlines = parse("<tool_call>\n<function=write>\n<parameter=path>\n/p\n</parameter>\n<parameter=content>\n\nbody\n\n</parameter>\n</function>\n</tool_call>");
  ok("only one newline trimmed on each side", extraNewlines.args?.content === "\nbody\n");
  const compact = parse("<tool_call><function=write><parameter=path>/p</parameter><parameter=content>x</parameter></function></tool_call>");
  ok("compact form without newlines", compact.args?.path === "/p" && compact.args?.content === "x");
  const spaced = parse("<tool_call>\n< function = write >\n<parameter = path>\n/p\n</ parameter>\n<parameter=content>\nx\n</parameter>\n</function>\n</tool_call>");
  ok("whitespace inside tags tolerated", spaced.args?.path === "/p" && spaced.args?.content === "x");

  const noParamClose = parse("<tool_call>\n<function=write>\n<parameter=path>\n/p\n<parameter=content>\nx\n</function>\n</tool_call>");
  ok("missing </parameter> in a closed block: value ends at the next tag",
    noParamClose.args?.path === "/p" && noParamClose.args?.content === "x");
  const noFunctionClose = parse("<tool_call>\n<function=write>\n<parameter=path>\n/p\n</parameter>\n<parameter=content>\nx\n</parameter>\n</tool_call>");
  ok("missing </function> tolerated", noFunctionClose.args?.content === "x");
  const cutAfterValue = parse("<tool_call>\n<function=write>\n<parameter=path>\n/p\n</parameter>\n<parameter=content>\nx\n</parameter>\n");
  ok("stream cut after a complete value: accepted", cutAfterValue.args?.content === "x");
  const cutMidValue = parse("<tool_call>\n<function=write>\n<parameter=path>\n/p\n</parameter>\n<parameter=content>\nhalf of the fi");
  ok("stream cut mid-value: not a call (would write a truncated file)",
    cutMidValue.toolCalls.length === 0 && /"content" for "write" was cut off/.test(cutMidValue.warnings[0]?.reason ?? ""));
  const glmCut = parse("<tool_call>write\n<arg_key>path</arg_key>\n<arg_value>/p</arg_value>\n<arg_key>content</arg_key>\n<arg_value>half");
  ok("GLM pairs cut mid-value: not a call either", glmCut.toolCalls.length === 0 && /cut off/.test(glmCut.warnings[0]?.reason ?? ""));

  const bare = "Writing now.\n<function=write>\n<parameter=path>\n/p\n</parameter>\n<parameter=content>\nx\n</parameter>\n</function>\n</tool_call>\nDone!";
  const bareParsed = parse(bare);
  ok("bare <function=…> without <tool_call>: a call", bareParsed.args?.path === "/p" && bareParsed.content === "Writing now.");
  const bareEvents = charByChar(bare);
  ok("bare block char by char: call, then stop at the trailing text",
    bareEvents.filter((event) => event.type === "tool_call").length === 1 && bareEvents.at(-1).type === "stop");
  const bareTwice = parse(`${bare.split("\nDone!")[0]}\n<function=read>\n<parameter=path>\n/q\n</parameter>\n</function>`);
  ok("stray </tool_call> between bare blocks skipped", bareTwice.toolCalls.map((call) => call.function.name).join() === "write,read");
  const prose = parse("Use <function=name> syntax in templates.");
  ok("prose mentioning <function= is not lost",
    prose.toolCalls.length === 0 && prose.content === "Use <function=name> syntax in templates.");

  const jsonInside = parse('<tool_call>\n<function=write>\n{"path": "/p", "content": "a\nb"}\n</function>\n</tool_call>');
  ok("JSON arguments inside <function=…>", jsonInside.args?.content === "a\nb");
  const hybrid = parse('<tool_call>\n<function=write>\n<parameter=path": "/p", "content": "say \\"hi\\"\nbye"}\n</parameter>\n</function>\n</tool_call>');
  ok("hybrid <parameter=key\": … JSON", hybrid.args?.path === "/p" && hybrid.args?.content === 'say "hi"\nbye');
  const hybridCut = parse('<tool_call>\n<function=write>\n<parameter=path": "/p", "content": "a\nb"}');
  ok("hybrid cut off after the JSON closed: accepted", hybridCut.args?.content === "a\nb");
  const missingRequired = parse("<tool_call>\n<function=write>\n<parameter=path>\n/p\n</parameter>\n</function>\n</tool_call>");
  ok("missing required parameter: not a call", missingRequired.toolCalls.length === 0 && /missing required/.test(missingRequired.warnings[0]?.reason ?? ""));
  const unknown = parse("<tool_call>\n<function=rm_rf>\n</function>\n</tool_call>");
  ok("unknown function name: not a call", unknown.toolCalls.length === 0 && /unknown tool "rm_rf"/.test(unknown.warnings[0]?.reason ?? ""));
}

// Neutral <proxy_call> format, for models whose <tool_call> text Venice
// consumes before it reaches the proxy.
function testProxyFormat() {
  section("proxy format (<proxy_call>)");

  ok("Qwen 3.5+ defaults to proxy; Qwen3 8B, Coder and GLM do not",
    resolveToolFormat("qwen-3-8-27b") === "proxy" && resolveToolFormat("qwen3-6-27b") === "proxy" &&
      resolveToolFormat("qwen3-8b") === "qwen" && resolveToolFormat("qwen3-coder-480b-a35b-instruct-turbo") === "json" &&
      resolveToolFormat("zai-org-glm-5-2") === "glm");
  const rules = parseToolFormatRules("qwen-3-8=qwen-xml,qwen3-coder=qwen-coder").rules;
  ok("env rules override per model", resolveToolFormat("qwen-3-8-27b", rules) === "qwen-xml" &&
    resolveToolFormat("qwen3-6-27b", rules) === "proxy" && resolveToolFormat("qwen3-coder-480b", rules) === "qwen-coder" &&
    resolveToolFormat("zai-org-glm-5-2", rules) === "glm");

  const prompt = buildToolSystemPrompt([WEATHER_TOOL], "auto", { format: "proxy" });
  ok("prompt asks for <proxy_call> everywhere",
    prompt.includes('<proxy_call>{"name": "TOOL_NAME"') && prompt.includes("Use one <proxy_call> block per call") &&
      prompt.includes("after the last </proxy_call>") && prompt.includes("without any <proxy_call> block"));
  // Spelling the stripped tag out makes the model repeat it while thinking,
  // which makes Venice cut the rest of the reply.
  const emptyNote = buildEmptyRetryMessages(resolveToolEmulation({ model: "qwen3-6-27b", messages: [{ role: "user", content: "x" }], tools: [WEATHER_TOOL] })).at(-1).content;
  ok("the proxy prompt, reminder and retry notes never write <tool_call>",
    !prompt.includes("tool_call>") && !prompt.includes("<tool_call") && !toolFormatReminder("proxy").includes("tool_call") &&
      !emptyNote.includes("tool_call") && !buildRetryMessages(resolveToolEmulation({ model: "qwen3-6-27b", messages: [{ role: "user", content: "x" }], tools: [WEATHER_TOOL] }), "x", "bad").at(-1).content.includes("tool_call"));
  ok("…but still rule out other tags, even while thinking",
    prompt.includes("not even while thinking") && toolFormatReminder("proxy").includes("not even in your reasoning"));
  const history = renderHistoryWithTools(
    [
      { role: "user", content: "x" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "18C" },
    ],
    { format: "proxy" },
  );
  ok("history renders proxy tags",
    history[1].content === '<proxy_call>{"name":"get_weather","arguments":{"city":"Paris"}}</proxy_call>' &&
      history[2].content === '<proxy_result name="get_weather" id="c1">18C</proxy_result>');

  const reply = 'Checking.\n<proxy_call>{"name": "get_weather", "arguments": {"city": "Paris"}}</proxy_call>\n</proxy_call>\n<proxy_call>{"name": "read_file", "arguments": {"path": "a"}}</proxy_call>\nDone.';
  const whole = feed(reply);
  const byChar = feed(reply, { chunkSize: 1 });
  ok("proxy calls parsed, stray closer skipped", whole.calls.map((call) => call.function.name).join() === "get_weather,read_file" &&
    whole.text === "Checking.");
  ok("proxy calls char by char", byChar.calls.length === 2 && byChar.text === "Checking." && byChar.events.at(-1).type === "stop");
  const partial = createToolCallParser(TOOL_NAMES);
  ok("partial <proxy_ca held back", partial.push("Hi <proxy_ca").map((event) => event.text).join("") === "Hi");
  ok("…and a tool_call still works next to it",
    feed('<tool_call>{"name":"get_weather","arguments":{"city":"x"}}</tool_call>').calls.length === 1);
  ok("look-alike <proxy_calls> stays text", feed("a <proxy_calls> b").text === "a <proxy_calls> b");
}

// "$$", "$&" and friends are special in String.prototype.replace replacement
// strings; no code path may use model output that way. Guards the "$/" → "$$/"
// seen live (a model error: the proxy never builds values with replace).
const DOLLAR_CONTENT = "re = /^\\d+$/; a = '$$'; b = \"$&\"; c = `$'`; d = '$`'; e = \"$1$2\";\n";

function testDollarPatterns() {
  section("dollar patterns pass through unchanged");
  const tools = [{ name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } }];
  const call = { id: "c", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "/$&", content: DOLLAR_CONTENT }) } };
  for (const format of TOOL_FORMAT_NAMES) {
    const rendered = renderHistoryWithTools([{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [call] }], { format })[1].content;
    const whole = parseToolCalls(rendered, tools).toolCalls[0];
    const parser = createToolCallParser(tools);
    const streamed = [...[...rendered].flatMap((char) => parser.push(char)), ...parser.end()].find((event) => event.type === "tool_call");
    ok(`${format}: $ patterns survive render, parse and streaming`,
      whole?.function.arguments === call.function.arguments && streamed?.toolCall.function.arguments === call.function.arguments);
  }
}

// A trailing newline in an argument value belongs to the value: no format
// path may drop it. (Files Qwen3-Coder wrote in opencode lacked one; these
// checks show that is the model, not the parser.)
function testTrailingNewlines() {
  section("trailing newlines in argument values");

  const writeTool = { name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } };
  const tools = [writeTool];
  const contents = ["a", "a\n", "a\n\n", "\na\n", 'x = "q";\n\n', "line one\nline two\n"];
  const contentOf = (text) => {
    const call = parseToolCalls(text, tools).toolCalls[0];
    return call ? args(call).content : undefined;
  };
  const streamedContentOf = (text) => {
    const parser = createToolCallParser(tools);
    const events = [...[...text].flatMap((char) => parser.push(char)), ...parser.end()];
    const call = events.find((event) => event.type === "tool_call")?.toolCall;
    return call ? args(call).content : undefined;
  };

  for (const format of TOOL_FORMAT_NAMES) {
    const exact = contents.every((content) => {
      const call = { id: "c", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "/p", content }) } };
      const rendered = renderHistoryWithTools(
        [{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [call] }],
        { format },
      )[1].content;
      return contentOf(rendered) === content && streamedContentOf(rendered) === content;
    });
    ok(`${format}: values ending in \\n and \\n\\n survive render and parse (whole and char by char)`, exact);
  }

  const written = {
    "json, escaped": ['<tool_call>{"name": "write", "arguments": {"path": "/p", "content": "a\\n\\n"}}</tool_call>', "a\n\n"],
    "json, raw newlines in the string": ['<tool_call>{"name": "write", "arguments": {"path": "/p", "content": "a\n\n"}}</tool_call>', "a\n\n"],
    "json, value is only newlines": ['<tool_call>{"name": "write", "arguments": {"path": "/p", "content": "\\n"}}</tool_call>', "\n"],
    "proxy": ['<proxy_call>{"name": "write", "arguments": {"path": "/p", "content": "a\\n"}}</proxy_call>', "a\n"],
    "qwen JSON block": ['<tool_call>\n{"name": "write", "arguments": {"path": "/p", "content": "a\\n\\n"}}\n</tool_call>', "a\n\n"],
    "glm inline": ["<tool_call>write\n<arg_key>path</arg_key>\n<arg_value>/p</arg_value>\n<arg_key>content</arg_key>\n<arg_value>a\n\n</arg_value>\n</tool_call>", "a\n\n"],
    "glm hybrid": ['<tool_call>write<arg_key>path": "/p", "content": "a\n\n"}</arg_value></tool_call>', "a\n\n"],
    "qwen XML, template form": ["<tool_call>\n<function=write>\n<parameter=path>\n/p\n</parameter>\n<parameter=content>\na\n\n\n</parameter>\n</function>\n</tool_call>", "a\n\n"],
    "qwen XML, compact form": ["<tool_call><function=write><parameter=path>/p</parameter><parameter=content>a\n\n</parameter></function></tool_call>", "a\n\n"],
    "qwen XML, compact single newline": ["<tool_call><function=write><parameter=path>/p</parameter><parameter=content>a\n</parameter></function></tool_call>", "a\n"],
  };
  for (const [label, [text, expected]] of Object.entries(written)) {
    ok(`${label}: trailing newlines kept`, contentOf(text) === expected && streamedContentOf(text) === expected,
      JSON.stringify(contentOf(text)));
  }
  ok("qwen XML: only the template's own wrapping newline pair is removed",
    contentOf("<tool_call>\n<function=write>\n<parameter=path>\n/p\n</parameter>\n<parameter=content>\na\n</parameter>\n</function>\n</tool_call>") === "a");
}

// The live opencode-like scenario's own fixture: right size, and the expected
// write() survives rendering and parsing in every format.
function testOpencodeFixture() {
  section("opencode-like fixture");

  ok("system prompt is about 30K characters",
    OPENCODE_SYSTEM_PROMPT.length >= 30_000 && OPENCODE_SYSTEM_PROMPT.length < 32_000, String(OPENCODE_SYSTEM_PROMPT.length));
  ok("the captured opencode tools: 12, all usable, write(path, content) among them",
    OPENCODE_TOOLS.length === 12 &&
      resolveToolEmulation({ messages: [{ role: "user", content: "x" }], tools: OPENCODE_TOOLS })?.tools.length === 12 &&
      JSON.stringify(OPENCODE_TOOLS.find((tool) => tool.function.name === "write")?.function.parameters.required) === '["path","content"]');
  ok("blank-line variant ends in exactly two newlines and its task says so",
    OPENCODE_WRITE_CONTENT_BLANK_END.endsWith("};\n\n") &&
      opencodeTask(OPENCODE_WRITE_CONTENT_BLANK_END, "keep both").includes("};\n\nEND") &&
      OPENCODE_TASK === opencodeTask(OPENCODE_WRITE_CONTENT));
  ok("write content has quotes, backslashes and newlines",
    /"/.test(OPENCODE_WRITE_CONTENT) && /'/.test(OPENCODE_WRITE_CONTENT) && /\\\\/.test(OPENCODE_WRITE_CONTENT) &&
      OPENCODE_WRITE_CONTENT.split("\n").length > 5);

  const tools = normalizeTools(OPENCODE_TOOLS);
  const writeCall = {
    id: "c1",
    type: "function",
    function: { name: "write", arguments: JSON.stringify({ path: OPENCODE_WRITE_PATH, content: OPENCODE_WRITE_CONTENT }) },
  };
  for (const format of TOOL_FORMAT_NAMES) {
    const rendered = renderHistoryWithTools(
      [{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [writeCall] }],
      { format },
    )[1].content;
    const parsed = parseToolCalls(rendered, tools).toolCalls[0];
    const parsedArgs = parsed ? args(parsed) : {};
    ok(`${format}: write() content survives render and parse`,
      parsedArgs.path === OPENCODE_WRITE_PATH && parsedArgs.content === OPENCODE_WRITE_CONTENT);
    const blankCall = { id: "c2", type: "function", function: { name: "write", arguments: JSON.stringify({ path: OPENCODE_WRITE_PATH, content: OPENCODE_WRITE_CONTENT_BLANK_END }) } };
    const blankRendered = renderHistoryWithTools(
      [{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [blankCall] }],
      { format },
    )[1].content;
    const blankParsed = parseToolCalls(blankRendered, tools).toolCalls[0];
    ok(`${format}: blank-line variant keeps both final newlines`,
      blankParsed && args(blankParsed).content === OPENCODE_WRITE_CONTENT_BLANK_END);
  }
}

function testCheckHelpers() {
  section("check:tools helpers");
  ok("first difference: position, line, column and context",
    describeFirstDifference("ab\ncd\nef", "ab\ncX\nef") === 'at char 4 (line 2, col 2): expected "ab\\ncd\\nef" got "ab\\ncX\\nef"; lengths 8 vs 8');
  ok("first difference: escaped newline shows up", describeFirstDifference("a\nb", "a\\nb").startsWith("at char 1 (line 1, col 2)"));
  ok("first difference: prefix and length", describeFirstDifference("abc", "abcdef").endsWith("lengths 3 vs 6"));
  ok("first difference: identical", describeFirstDifference("same", "same") === "identical");
  const long = "x".repeat(40);
  ok("first difference: long strings elided around the spot",
    describeFirstDifference(`${long}A${long}`, `${long}B${long}`).includes('expected …"xxxxxxxxxxxxxxxAxxxxxxxxxxxxxx"…'));
}

// ──────────────────────────────────────────────
// Retry, early stop and upstream cancellation
// ──────────────────────────────────────────────

// A scripted upstream: each attempt yields its chunks as content events and
// records how far it was read and whether it was closed early.
function scriptedUpstream(attempts) {
  const log = [];
  const open = (messages) => {
    const script = attempts[log.length] ?? [];
    const entry = { messages, read: 0, closedEarly: false };
    log.push(entry);
    return (async function* () {
      let finished = false;
      try {
        for (const item of script) {
          entry.read += 1;
          yield typeof item === "string" ? { type: "content", text: item } : item;
        }
        finished = true;
      } finally {
        entry.closedEarly = !finished;
      }
    })();
  };
  return { open, log };
}

async function collect(emulation, attempts, options = {}) {
  const upstream = scriptedUpstream(attempts);
  const reports = [];
  const stats = {};
  const events = [];
  for await (const event of runToolEmulation({
    emulation,
    openAttempt: upstream.open,
    onEvent: (report) => reports.push(report),
    stats,
    ...options,
  })) {
    events.push(event);
  }
  return {
    events,
    text: events.filter((event) => event.type === "text").map((event) => event.text).join(""),
    calls: events.filter((event) => event.type === "tool_call").map((event) => event.toolCall),
    reports,
    stats,
    upstream: upstream.log,
  };
}

async function testRunToolEmulation() {
  section("runToolEmulation — retry and early stop");

  const emulation = resolveToolEmulation({
    model: "zai-org-glm-5-2",
    messages: [{ role: "user", content: "Weather in Paris?" }],
    tools: [WEATHER_TOOL],
  });
  const good = "<tool_call>get_weather\n<arg_key>city</arg_key>\n<arg_value>Paris</arg_value>\n</tool_call>";
  const bad = '<tool_call>get_weather<arg_key>city": </tool_call>';

  const plain = await collect(emulation, [["It is ", "sunny."]]);
  ok("plain answer streams through in one attempt", plain.text === "It is sunny." && plain.upstream.length === 1);

  const direct = await collect(emulation, [["Checking. ", good]]);
  ok("valid call: one attempt, text and call", direct.text === "Checking." && direct.calls.length === 1 && direct.stats.attempts === 1);

  const reasoning = await collect(emulation, [[{ type: "meta", completionId: "c1", model: "m" }, { type: "reasoning", text: `think ${bad}` }, good]]);
  ok("reasoning and meta pass through, never parsed",
    reasoning.events[0].type === "meta" && reasoning.events[1].text === `think ${bad}` && reasoning.calls.length === 1);

  const stopped = await collect(emulation, [["Ok. ", good, "\nI made a mistake with the format. ", "Let me fix that. ", bad, " more", " more"]]);
  ok("after a call, further text stops the reply", stopped.calls.length === 1 && stopped.text === "Ok.");
  ok("upstream closed early after the call", stopped.upstream[0].closedEarly && stopped.upstream[0].read === 3);

  const parallel = await collect(emulation, [[good, "\n\n", good.replace("Paris", "Rome"), "\nDone."]]);
  ok("several calls in a row are all returned", parallel.calls.length === 2 && args(parallel.calls[1]).city === "Rome");
  ok("…and the trailing text still stops it", parallel.upstream[0].closedEarly);

  const single = resolveToolEmulation({
    model: "zai-org-glm-5-2",
    messages: [{ role: "user", content: "x" }],
    tools: [WEATHER_TOOL],
    parallel_tool_calls: false,
  });
  const capped = await collect(single, [[good, "\n", good, "\n", good]]);
  ok("parallel_tool_calls:false stops right after the first call",
    capped.calls.length === 1 && capped.upstream[0].read === 1 && capped.upstream[0].closedEarly);

  const retried = await collect(emulation, [["Let me check. ", bad, " trailing"], ["Sorry about that: ", good]]);
  ok("unparsed call: retried once", retried.upstream.length === 2 && retried.stats.attempts === 2);
  ok("first attempt closed at the bad block", retried.upstream[0].closedEarly && retried.upstream[0].read === 2);
  ok("retry result returned as the call", retried.calls.length === 1 && args(retried.calls[0]).city === "Paris");
  ok("bad block never sent, retry text not shown", retried.text === "Let me check." && !retried.text.includes("<tool_call"));
  const retryMessages = retried.upstream[1].messages;
  ok("retry sends the raw reply back as the assistant turn",
    retryMessages.at(-2).role === "assistant" && retryMessages.at(-2).content === `Let me check. ${bad}`);
  ok("retry adds a correction in the model's format",
    retryMessages.at(-1).role === "user" && retryMessages.at(-1).content.includes("could not be parsed") &&
      retryMessages.at(-1).content.includes("<arg_key>ARGUMENT</arg_key>"));
  ok("retry logged with the first output", retried.reports.length === 1 && retried.reports[0].type === "retry" &&
    retried.reports[0].outputs[0] === `Let me check. ${bad}`);

  const failed = await collect(emulation, [[bad], ["Still ", bad]]);
  ok("both attempts fail: the original block comes back as text", failed.text === bad && failed.calls.length === 0);
  ok("failure logged with both raw outputs",
    failed.reports.at(-1)?.type === "failed" && failed.reports.at(-1).outputs.join("|") === `${bad}|Still ${bad}`);

  const gaveUp = await collect(emulation, [[bad], ["I cannot call that tool."]]);
  ok("retry without a call also falls back to the original text", gaveUp.text === bad && gaveUp.reports.at(-1)?.type === "failed");

  const truncated = await collect(emulation, [['<tool_call>get_weather<arg_key>city": "Par'], [good]]);
  ok("unterminated, unparsable block at end of stream is retried", truncated.calls.length === 1 && truncated.stats.attempts === 2);

  const meta = await collect(emulation, [[{ type: "meta", completionId: "first" }, bad], [{ type: "meta", completionId: "second" }, good]]);
  ok("meta only from the first attempt",
    meta.events.filter((event) => event.type === "meta").map((event) => event.completionId).join() === "first");
}

async function testReasoningBudget() {
  section("reasoning budget");

  ok("budget setting: default, 0, number, junk",
    parseReasoningBudget(undefined) === DEFAULT_REASONING_BUDGET && DEFAULT_REASONING_BUDGET === 32_000 &&
      parseReasoningBudget("0") === 0 && parseReasoningBudget("5000") === 5000 &&
      parseReasoningBudget("abc") === DEFAULT_REASONING_BUDGET && parseReasoningBudget("-1") === DEFAULT_REASONING_BUDGET);

  const emulation = resolveToolEmulation({
    model: "qwen-3-8-27b",
    messages: [{ role: "user", content: "Weather in Paris?" }],
    tools: [WEATHER_TOOL],
  });
  const good = '<proxy_call>{"name": "get_weather", "arguments": {"city": "Paris"}}</proxy_call>';
  const think = (chars) => ({ type: "reasoning", text: "x".repeat(chars) });
  const loop = Array.from({ length: 20 }, () => think(600));
  const budget = { reasoningBudget: 1000 };

  const recovered = await collect(emulation, [[...loop, good], ["Here: ", good]], budget);
  ok("overrun: upstream cancelled once the budget is passed",
    recovered.upstream[0].closedEarly && recovered.upstream[0].read === 2);
  ok("overrun: retried once with a brevity nudge on the last user turn",
    recovered.stats.attempts === 2 && recovered.upstream[1].messages.at(-1).content.endsWith(
      "[Keep your reasoning brief: answer or call a tool right away.]"));
  ok("overrun: the retry's text and call are returned", recovered.text === "Here:" && recovered.calls.length === 1);
  ok("overrun: logged", recovered.reports[0]?.type === "overrun" && /passed 1000 characters/.test(recovered.reports[0].reason));
  ok("overrun: reasoning before the cut was streamed", recovered.events.filter((event) => event.type === "reasoning").length >= 2);

  const answered = await collect(emulation, [loop, ["It is sunny in Paris."]], budget);
  ok("overrun then a plain answer: the answer is returned",
    answered.text === "It is sunny in Paris." && !answered.events.some((event) => event.type === "error"));

  const twice = await collect(emulation, [loop, loop], budget);
  const error = twice.events.at(-1);
  ok("overrun twice: a clear error instead of waiting",
    error?.type === "error" && error.code === "reasoning_budget_exceeded" && /VENICE_TOOL_REASONING_BUDGET/.test(error.message));
  ok("overrun twice: both upstream requests cancelled early",
    twice.upstream.every((attempt) => attempt.closedEarly && attempt.read === 2));
  ok("overrun twice: logged as failed", twice.reports.at(-1)?.type === "failed");

  const late = await collect(emulation, [["Let me check. ", think(5000), good]], budget);
  ok("reasoning after the answer started does not count", late.calls.length === 1 && late.stats.attempts === 1);
  const blank = await collect(emulation, [["\n\n", ...loop], [good]], budget);
  ok("whitespace content is not an answer: still an overrun", blank.stats.attempts === 2 && blank.calls.length === 1);
  const unlimited = await collect(emulation, [[think(50_000), good]], { reasoningBudget: 0 });
  ok("budget 0: no limit", unlimited.calls.length === 1 && unlimited.stats.attempts === 1);
  const bad = '<proxy_call>{"name": "get_weather", "arguments": </proxy_call>';
  const badThenLoop = await collect(emulation, [[bad], loop], budget);
  ok("unparsed call, then an overrun: the original block comes back as text",
    badThenLoop.text === bad && !badThenLoop.events.some((event) => event.type === "error"));
}

async function testEmptyReplies() {
  section("empty replies");

  const emulation = resolveToolEmulation({
    model: "qwen3-6-27b",
    messages: [{ role: "user", content: "Weather in Paris?" }],
    tools: [WEATHER_TOOL],
  });
  const good = '<proxy_call>{"name": "get_weather", "arguments": {"city": "Paris"}}</proxy_call>';

  const recovered = await collect(emulation, [[{ type: "reasoning", text: "I will call the tool." }, "\n\n"], ["Checking. ", good]]);
  ok("empty reply: retried once", recovered.stats.attempts === 2 && recovered.reports[0]?.type === "empty");
  const retryTurn = recovered.upstream[1].messages;
  ok("empty reply: format repeated on the last user turn, no extra user message",
    retryTurn.length === emulation.messages.length && retryTurn.at(-1).role === "user" &&
      retryTurn.at(-1).content.includes("arrived empty") && retryTurn.at(-1).content.includes("<proxy_call>{\"name\": \"TOOL_NAME\""));
  ok("empty reply: the retry's text and call are returned, no stray whitespace",
    recovered.text === "Checking." && recovered.calls.length === 1);

  const answered = await collect(emulation, [[""], ["It is sunny."]]);
  ok("empty, then a plain answer: the answer is returned", answered.text === "It is sunny." && answered.calls.length === 0);

  const twice = await collect(emulation, [["\n"], [" \n"]]);
  ok("empty twice: ends empty, logged as failed, nothing else sent",
    twice.stats.attempts === 2 && twice.calls.length === 0 && !twice.events.some((event) => event.type === "error") &&
      twice.reports.at(-1)?.type === "failed" && /reply was empty/.test(twice.reports.at(-1).reason));

  const plain = await collect(emulation, [["It is sunny.\n\n"]]);
  ok("a real answer is not retried and keeps its trailing whitespace", plain.stats.attempts === 1 && plain.text === "It is sunny.\n\n");
  const jsonEmulation = resolveToolEmulation({ model: "llama", messages: [{ role: "user", content: "x" }], tools: [WEATHER_TOOL] });
  const jsonRetry = await collect(jsonEmulation, [[""], ["ok"]]);
  ok("the empty-reply note names the model's own format", jsonRetry.upstream[1].messages.at(-1).content.includes("<tool_call>{\"name\""));
}

async function testStreamCancellation() {
  section("upstream cancellation");

  const makeBody = (lines) => {
    const state = { cancelled: false, pulled: 0 };
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      pull(controller) {
        if (state.pulled >= lines.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(lines[state.pulled]));
        state.pulled += 1;
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { body, state };
  };

  const jsonLines = makeBody(Array.from({ length: 50 }, (_, index) => `{"kind":"content","content":"${index}"}\n`));
  for await (const event of parseJsonLineStream(jsonLines.body)) {
    if (event.content === "2") {
      break;
    }
  }
  ok("JSON-lines reader cancels the body when left early", jsonLines.state.cancelled && jsonLines.state.pulled < 50);

  const complete = makeBody(['{"kind":"content","content":"a"}\n']);
  for await (const _event of parseJsonLineStream(complete.body)) {
    // Read everything.
  }
  ok("fully read body is not cancelled", !complete.state.cancelled);

  const sse = makeBody(Array.from({ length: 50 }, (_, index) => `event: e\ndata: {"i":${index}}\n\n`));
  for await (const event of parseClientSseStream(sse.body)) {
    if (event.data.i === 1) {
      break;
    }
  }
  ok("agent SSE reader cancels the body when left early", sse.state.cancelled && sse.state.pulled < 50);
}

// ──────────────────────────────────────────────
// Proxy wiring with a stubbed Venice client
// ──────────────────────────────────────────────

function parseSse(text) {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice(6))
    .map((data) => (data === "[DONE]" ? data : JSON.parse(data)));
}

async function testProxyWiring() {
  section("proxy wiring — stubbed upstream");

  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line) => logs.push(String(line));
  console.warn = (line) => logs.push(String(line));

  const proxy = createVeniceOpenAiProxy();
  proxy.ensureAuth = async () => ({ login: { clerkJwt: "jwt" } });
  let upstream = null;
  let chatEvents = [];
  let agentEvents = [];
  proxy.client.chat = async (_jwt, _input, options) => {
    upstream = options;
    return {
      events: chatEvents,
      text: chatEvents.filter((event) => event.kind === "content").map((event) => event.content ?? "").join(""),
    };
  };
  let chatStreamRead = 0;
  let chatStreamClosedEarly = false;
  proxy.client.openChatStream = async (_jwt, _input, options) => {
    upstream = options;
    chatStreamRead = 0;
    chatStreamClosedEarly = false;
    return {
      events: (async function* () {
        let finished = false;
        try {
          for (const event of chatEvents) {
            chatStreamRead += 1;
            yield event;
          }
          finished = true;
        } finally {
          chatStreamClosedEarly = !finished;
        }
      })(),
    };
  };
  proxy.client.openAgentChatStream = async (_jwt, messages) => {
    upstream = messages;
    return { events: (async function* () { yield* agentEvents; })() };
  };

  const server = createVeniceOpenAiProxyServer(proxy);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const post = async (body, headers = {}) => {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  };

  const history = [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Weather in Paris?" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "18C rain" },
    { role: "user", content: "And Rome?" },
  ];
  const callText = '<tool_call>{"name":"get_weather","arguments":{"city":"Rome"}}</tool_call>';

  try {
    // Streaming, chat endpoint: tag split across many small content events.
    chatEvents = [
      { kind: "meta", completion_id: "abc", servingModelId: "glm-serving" },
      { kind: "content", reasoning_content: "Need <tool_call> for Rome." },
      ...`One sec. ${callText} ignored`.match(/[\s\S]{1,3}/g).map((content) => ({ kind: "content", content })),
    ];
    const streamed = await post({ model: "zai-org-glm-5-2", stream: true, messages: history, tools: [WEATHER_TOOL] });
    const chunks = parseSse(streamed.text);
    const deltas = chunks.filter((chunk) => chunk !== "[DONE]").map((chunk) => chunk.choices?.[0]).filter(Boolean);
    const toolDeltas = deltas.flatMap((choice) => choice.delta?.tool_calls ?? []);
    ok("stream: status 200", streamed.status === 200);
    ok("stream: ends with [DONE]", chunks.at(-1) === "[DONE]");
    ok("stream: first delta has role", deltas[0]?.delta?.role === "assistant");
    ok("stream: reasoning passed through unscanned",
      deltas.some((choice) => choice.delta?.reasoning_content === "Need <tool_call> for Rome."));
    ok("stream: text before the call streamed",
      deltas.map((choice) => choice.delta?.content ?? "").join("") === "One sec.");
    ok("stream: opening tool delta has id, type and name",
      typeof toolDeltas[0]?.id === "string" && toolDeltas[0]?.type === "function" &&
        toolDeltas[0]?.function?.name === "get_weather" && toolDeltas[0]?.index === 0);
    ok("stream: arguments delta", JSON.parse(toolDeltas[1]?.function?.arguments ?? "{}").city === "Rome");
    ok("stream: finish_reason tool_calls", deltas.at(-1)?.finish_reason === "tool_calls");
    ok("stream: no text after the call", !streamed.text.includes("ignored"));
    ok("stream: upstream closed once the call was complete",
      chatStreamClosedEarly && chatStreamRead < chatEvents.length);

    const systemPrompt = upstream?.systemPrompt ?? "";
    ok("upstream: system prompt kept and GLM tool section appended",
      systemPrompt.startsWith("Be brief.\n\n# Tools") && systemPrompt.includes('"name":"get_weather"') &&
        systemPrompt.includes("<arg_key>{arg-key-1}</arg_key>"));
    ok("upstream: tool section ends the system prompt",
      systemPrompt.trimEnd().endsWith("answer normally without any <tool_call> block."));
    ok("upstream: last user turn ends with the GLM reminder",
      upstream?.promptMessages?.at(-1)?.content.endsWith(toolFormatReminder("glm")));
    const prompt = upstream?.promptMessages ?? [];
    ok("upstream: assistant tool call kept in history (GLM format)",
      prompt.some((message) => message.role === "assistant" &&
        message.content.includes("<tool_call>get_weather\n<arg_key>city</arg_key>\n<arg_value>Paris</arg_value>")));
    ok("upstream: tool result rendered as GLM tool_response",
      prompt.some((message) => message.role === "user" &&
        message.content.startsWith("<tool_response>\n18C rain\n</tool_response>")));
    ok("log: translate line has tools, tool_choice and format",
      logs.some((line) => line.includes(" translate ") && line.includes("tools=1 tool_choice=auto tool_format=glm")));
    ok("log: outgoing line has tool_calls",
      logs.some((line) => line.includes(" outgoing ") && line.includes("tools=1 tool_calls=1")));

    // Model suffix features that would compete with the tools are forced off.
    chatEvents = [{ kind: "content", content: callText }];
    await post({
      model: "zai-org-glm-5-2:webEnabled=true&xSearchEnabled=1&includeVeniceSystemPrompt=true",
      messages: history,
      tools: [WEATHER_TOOL],
    });
    ok("tools: web, X search and Venice system prompt forced off",
      upstream?.webEnabled === false && upstream?.webScrapeEnabled === false && upstream?.xSearchEnabled === false &&
        upstream?.includeVeniceSystemPrompt === false);
    ok("tools: overrides logged",
      logs.some((line) => line.includes("venice_system_prompt=false(tools)") &&
        line.includes("disabled_for_tools=webEnabled,xSearchEnabled,includeVeniceSystemPrompt")));
    await post({ model: "zai-org-glm-5-2:webEnabled=true", messages: history });
    ok("no tools: suffix features untouched", upstream?.webEnabled === true);

    // A model without a native format gets the generic JSON format.
    chatEvents = [{ kind: "content", content: callText }];
    await post({ model: "llama-3.3-70b", messages: history, tools: [WEATHER_TOOL] });
    ok("json format: tool section and tool_result history",
      upstream?.systemPrompt?.includes("### get_weather") &&
        upstream?.promptMessages?.some((message) =>
          message.content.startsWith('<tool_result name="get_weather" id="call_1">18C rain</tool_result>')));

    // Non-streaming, chat endpoint.
    chatEvents = [{ kind: "meta", completion_id: "abc", servingModelId: "glm-serving" }, { kind: "content", content: `Checking. ${callText}` }];
    const single = JSON.parse((await post({ model: "zai-org-glm-5-2", messages: history, tools: [WEATHER_TOOL] })).text);
    const message = single.choices?.[0]?.message;
    ok("non-stream: finish_reason tool_calls", single.choices?.[0]?.finish_reason === "tool_calls");
    ok("non-stream: content is text before the call", message?.content === "Checking.");
    ok("non-stream: tool_calls returned",
      message?.tool_calls?.length === 1 && message.tool_calls[0].function.name === "get_weather");

    // Non-streaming, plain answer with tools available.
    chatEvents = [{ kind: "content", content: "It is sunny." }];
    const plain = JSON.parse((await post({ model: "zai-org-glm-5-2", messages: history, tools: [WEATHER_TOOL] })).text);
    ok("non-stream plain: finish_reason stop and no tool_calls",
      plain.choices?.[0]?.finish_reason === "stop" && plain.choices?.[0]?.message?.tool_calls === undefined &&
        plain.choices?.[0]?.message?.content === "It is sunny.");

    // Malformed call: text comes back and a warning is logged with the model.
    chatEvents = [{ kind: "meta", servingModelId: "glm-serving" }, { kind: "content", content: '<tool_call>{"name": oops}</tool_call>' }];
    const malformed = await post({ model: "zai-org-glm-5-2", stream: true, messages: history, tools: [WEATHER_TOOL] });
    const malformedDeltas = parseSse(malformed.text).filter((chunk) => chunk !== "[DONE]").map((chunk) => chunk.choices?.[0]).filter(Boolean);
    ok("stream malformed: raw text returned",
      malformedDeltas.map((choice) => choice.delta?.content ?? "").join("") === '<tool_call>{"name": oops}</tool_call>');
    ok("stream malformed: finish_reason stop", malformedDeltas.at(-1)?.finish_reason === "stop");
    ok("stream malformed: retry logged with the raw output",
      logs.some((line) => line.includes("tool emulation: unparsed tool call; retrying once (invalid JSON)") &&
        line.includes("output1=")));
    ok("stream malformed: failure logged with both outputs and the model",
      logs.some((line) => line.includes("retry failed too") && line.includes("model=glm-serving") &&
        line.includes("output1=") && line.includes("output2=")));

    // x-venice-tool-debug: the response reports the upstream attempts.
    const debug = { "x-venice-tool-debug": "1" };
    const retriedStream = parseSse((await post({ model: "zai-org-glm-5-2", stream: true, messages: history, tools: [WEATHER_TOOL] }, debug)).text);
    ok("debug header, stream: attempts=2 after a retry on the finish chunk",
      retriedStream.find((chunk) => chunk.choices?.[0]?.finish_reason)?.venice_tool_attempts === 2);
    const retriedJson = JSON.parse((await post({ model: "zai-org-glm-5-2", messages: history, tools: [WEATHER_TOOL] }, debug)).text);
    ok("debug header, non-stream: attempts=2 after a retry", retriedJson.venice_tool_attempts === 2);
    chatEvents = [{ kind: "content", content: callText }];
    const firstTry = JSON.parse((await post({ model: "zai-org-glm-5-2", messages: history, tools: [WEATHER_TOOL] }, debug)).text);
    ok("debug header: attempts=1 when the first reply parses", firstTry.venice_tool_attempts === 1);
    const plainJson = JSON.parse((await post({ model: "zai-org-glm-5-2", messages: history, tools: [WEATHER_TOOL] })).text);
    const plainStream = (await post({ model: "zai-org-glm-5-2", stream: true, messages: history, tools: [WEATHER_TOOL] })).text;
    ok("no debug header: no attempts field", !("venice_tool_attempts" in plainJson) && !plainStream.includes("venice_tool_attempts"));

    // "$" patterns in text and in call arguments reach the client unchanged.
    const dollarCall = `<tool_call>write\n<arg_key>path</arg_key>\n<arg_value>/p</arg_value>\n<arg_key>content</arg_key>\n<arg_value>${DOLLAR_CONTENT}</arg_value>\n</tool_call>`;
    const writeTool = { type: "function", function: { name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } };
    for (const stream of [false, true]) {
      chatEvents = [{ kind: "content", content: "Cost: $$5 and $&. " }, ...dollarCall.match(/[\s\S]{1,3}/g).map((content) => ({ kind: "content", content }))];
      const response = await post({ model: "zai-org-glm-5-2", stream, messages: history, tools: [writeTool] });
      let text = "";
      let argsText = "";
      if (stream) {
        for (const chunk of parseSse(response.text).filter((item) => item !== "[DONE]")) {
          text += chunk.choices?.[0]?.delta?.content ?? "";
          argsText += chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? "";
        }
      } else {
        const message = JSON.parse(response.text).choices[0].message;
        text = message.content;
        argsText = message.tool_calls[0].function.arguments;
      }
      ok(`proxy (stream=${stream}): $ patterns unchanged in text and arguments`,
        text === "Cost: $$5 and $&." && JSON.parse(argsText).content === DOLLAR_CONTENT, `${text} ${argsText}`);
    }

    // Reasoning that runs past the budget (default 32K) twice: a clear error.
    chatEvents = [
      { kind: "meta", servingModelId: "qwen-serving" },
      ...Array.from({ length: 40 }, () => ({ kind: "content", reasoning_content: "y".repeat(1000) })),
      { kind: "content", content: "never reached" },
    ];
    logs.length = 0;
    const overrunJson = await post({ model: "qwen-3-8-27b", messages: history, tools: [WEATHER_TOOL] });
    const overrunError = JSON.parse(overrunJson.text).error;
    ok("budget, non-stream: 504 reasoning_budget_exceeded",
      overrunJson.status === 504 && overrunError?.code === "reasoning_budget_exceeded" && overrunError?.type === "server_error");
    ok("budget: upstream cancelled before the end", chatStreamClosedEarly && chatStreamRead < chatEvents.length);
    ok("budget: overrun and failure logged with status 504",
      logs.some((line) => line.includes("reasoning overran the budget")) &&
        logs.some((line) => line.includes(" outgoing ") && line.includes("status=504") && line.includes("tool_attempts=2")));
    const overrunStream = parseSse((await post({ model: "qwen-3-8-27b", stream: true, messages: history, tools: [WEATHER_TOOL] })).text);
    ok("budget, stream: reasoning streamed, then an OpenAI-style error chunk and [DONE]",
      overrunStream.some((chunk) => chunk.choices?.[0]?.delta?.reasoning_content) &&
        overrunStream.at(-2)?.error?.code === "reasoning_budget_exceeded" &&
        overrunStream.at(-2)?.error?.type === "invalid_request_error" && overrunStream.at(-1) === "[DONE]" &&
        !overrunStream.some((chunk) => chunk.choices?.[0]?.finish_reason));

    // An empty reply is retried; the client gets the retry's call.
    for (const stream of [false, true]) {
      let attempt = 0;
      const emptyThenCall = [
        [{ kind: "content", reasoning_content: "Calling the tool." }, { kind: "content", content: "\n\n" }],
        [{ kind: "content", content: '<proxy_call>{"name": "get_weather", "arguments": {"city": "Rome"}}</proxy_call>' }],
      ];
      const original = proxy.client.openChatStream;
      proxy.client.openChatStream = async (_jwt, _input, options) => {
        upstream = options;
        const events = emptyThenCall[Math.min(attempt, 1)];
        attempt += 1;
        return { events: (async function* () { yield* events; })() };
      };
      const response = await post({ model: "qwen3-6-27b", stream, messages: history, tools: [WEATHER_TOOL] }, { "x-venice-tool-debug": "1" });
      proxy.client.openChatStream = original;
      const calls = stream
        ? parseSse(response.text).flatMap((chunk) => chunk?.choices?.[0]?.delta?.tool_calls ?? [])
        : JSON.parse(response.text).choices[0].message.tool_calls ?? [];
      const attempts = stream
        ? parseSse(response.text).find((chunk) => chunk?.venice_tool_attempts)?.venice_tool_attempts
        : JSON.parse(response.text).venice_tool_attempts;
      ok(`proxy (stream=${stream}): empty reply retried, call returned`,
        attempt === 2 && attempts === 2 && calls.some((call) => call.function?.name === "get_weather") &&
          upstream.promptMessages.at(-1).content.includes("arrived empty"));
    }

    // Trailing newlines in a call's arguments reach the client unchanged.
    const blankEnd = "export const x = 1;\n\n";
    for (const [model, reply] of [
      ["llama-3.3-70b", `<tool_call>{"name": "write", "arguments": {"path": "/p", "content": ${JSON.stringify(blankEnd)}}}</tool_call>`],
      ["zai-org-glm-5-2", `<tool_call>write\n<arg_key>path</arg_key>\n<arg_value>/p</arg_value>\n<arg_key>content</arg_key>\n<arg_value>${blankEnd}</arg_value>\n</tool_call>`],
      ["qwen3-6-27b", `<proxy_call>{"name": "write", "arguments": {"path": "/p", "content": ${JSON.stringify(blankEnd)}}}</proxy_call>`],
    ]) {
      for (const stream of [false, true]) {
        chatEvents = reply.match(/[\s\S]{1,5}/g).map((content) => ({ kind: "content", content }));
        const writeOnly = { type: "function", function: { name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } };
        const response = await post({ model, stream, messages: history, tools: [writeOnly] });
        const argsText = stream
          ? parseSse(response.text).filter((chunk) => chunk !== "[DONE]")
            .map((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? "").join("")
          : JSON.parse(response.text).choices[0].message.tool_calls?.[0]?.function?.arguments ?? "";
        ok(`proxy ${model} (stream=${stream}): content ending in a blank line arrives exact`,
          argsText !== "" && JSON.parse(argsText).content === blankEnd, argsText);
      }
    }

    // Upstream events the proxy does not use are reported once per request.
    chatEvents = [
      { kind: "meta", servingModelId: "qwen-serving" },
      { kind: "toolCall", name: "get_weather", arguments: '{"city":"Paris"}' },
      "data: not json",
      { kind: "content", content: "Sunny.", tool_calls: [] },
    ];
    logs.length = 0;
    await post({ model: "qwen-3-8-27b", stream: true, messages: history, tools: [WEATHER_TOOL] });
    ok("ignored upstream events logged with kinds and counts",
      logs.some((line) => line.includes("tool emulation: ignored upstream events model=qwen-3-8-27b") &&
        line.includes("kind:toolCall×1") && line.includes('non-json:"data: not json"×1') && line.includes("content.tool_calls×1")));

    // Agent endpoints run only Venice's server-side tools: tools get a 400.
    for (const [label, body] of [
      ["agent endpoint, streaming", { model: "deepseek-v4-1-flash-free", stream: true, messages: history, tools: [WEATHER_TOOL] }],
      ["agent endpoint, non-streaming", { model: "deepseek-v4-1-flash-free", messages: history, tools: [WEATHER_TOOL] }],
      ["agentic alias", { model: "agentic", messages: history, tools: [WEATHER_TOOL] }],
    ]) {
      upstream = null;
      const response = await post(body);
      const error = JSON.parse(response.text).error;
      ok(`${label}: tools → 400 tools_not_supported`,
        response.status === 400 && error?.type === "invalid_request_error" && error?.code === "tools_not_supported" &&
          error?.param === "tools" && /not supported for model/.test(error?.message ?? ""));
      ok(`${label}: nothing sent upstream`, upstream === null);
    }
    agentEvents = [
      { event: "response.output_item.added", data: { output_index: 0, item: { type: "message" } } },
      { event: "response.output_text.delta", data: { output_index: 0, delta: "hi" } },
      { event: "response.completed", data: { response: { status: "completed" } } },
    ];
    for (const [label, extra] of [["no tools", {}], ["tool_choice none", { tools: [WEATHER_TOOL], tool_choice: "none" }], ["empty tools", { tools: [] }]]) {
      const response = await post({ model: "deepseek-v4-1-flash-free", messages: history, ...extra });
      ok(`agent endpoint, ${label}: served as before`,
        response.status === 200 && JSON.parse(response.text).choices?.[0]?.message?.content === "hi");
    }
  } finally {
    server.close();
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

// ──────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────

async function main() {
  testParser();
  testStreamingParser();
  testHistory();
  testFormats();
  testLoggedFixtures();
  testQwenXml();
  testProxyFormat();
  testDollarPatterns();
  testTrailingNewlines();
  testOpencodeFixture();
  testCheckHelpers();
  await testRunToolEmulation();
  await testReasoningBudget();
  await testEmptyReplies();
  await testStreamCancellation();
  await testProxyWiring();

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
