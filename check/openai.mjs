import { pathToFileURL } from "node:url";
import OpenAI from "openai";

const PORT = Number(process.env.PORT || process.env.VENICE_PROXY_PORT || 3456);
const BASE_URL = process.env.CHECK_PROXY_BASE_URL?.trim() || `http://localhost:${PORT}/v1`;
const MODEL = process.env.CHECK_PROXY_MODEL?.trim() || undefined;

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

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

async function testListModels(client) {
  section("GET /v1/models");
  const list = await client.models.list();

  ok("response has object='list'", list.object === "list");
  ok("data is a non-empty array", Array.isArray(list.data) && list.data.length > 0);

  const first = list.data[0];
  ok("first model has id string", typeof first?.id === "string" && first.id.length > 0);
  ok("first model has object='model'", first?.object === "model");
  ok("first model has created number", typeof first?.created === "number");
  ok("first model has owned_by string", typeof first?.owned_by === "string");

  console.log(`  info  ${list.data.length} models; first = ${first?.id}`);
  return first?.id;
}

async function testChatCompletionNonStreaming(client, model) {
  section("POST /v1/chat/completions — non-streaming");

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "You are a concise assistant. Keep responses very short." },
      { role: "user", content: "Say exactly: hello world" },
    ],
    max_tokens: 30,
    temperature: 0.1,
    stream: false,
  });

  ok("id starts with 'chatcmpl'", typeof response.id === "string" && response.id.startsWith("chatcmpl"));
  ok("object='chat.completion'", response.object === "chat.completion");
  ok("model field is a non-empty string", typeof response.model === "string" && response.model.length > 0);
  ok("created is a positive number", typeof response.created === "number" && response.created > 0);
  ok("choices is a non-empty array", Array.isArray(response.choices) && response.choices.length > 0);

  const choice = response.choices[0];
  ok("choice[0].index === 0", choice?.index === 0);
  ok("choice[0].finish_reason === 'stop'", choice?.finish_reason === "stop");
  ok("choice[0].message.role === 'assistant'", choice?.message?.role === "assistant");
  ok("choice[0].message.content is a non-empty string",
    typeof choice?.message?.content === "string" && choice.message.content.length > 0,
  );

  console.log(`  info  response.model = ${response.model}`);
  console.log(`  info  content = ${JSON.stringify(choice?.message?.content)}`);
}

async function testChatCompletionStreaming(client, model) {
  section("POST /v1/chat/completions — streaming");

  const stream = await client.chat.completions.create({
    model,
    messages: [
      { role: "user", content: "Tell me the most recent news headline you know of. Use web seacrching if needed." },
    ],
    max_tokens: 3000,
    temperature: 0.7,
    stream: true,
  });

  let totalContent = "";
  let totalReasoning = "";
  let chunkCount = 0;
  let reasoningChunkCount = 0;
  let contentChunkCount = 0;
  let firstChunkRole = null;
  let finishReason = null;
  let lastModel = null;

  for await (const chunk of stream) {
    chunkCount += 1;
    const delta = chunk.choices?.[0]?.delta;
    lastModel = chunk.model ?? lastModel;
    if (delta?.role && firstChunkRole === null) {
      firstChunkRole = delta.role;
    }
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content !== "") {
      totalReasoning += delta.reasoning_content;
      reasoningChunkCount += 1;
    }
    if (typeof delta?.content === "string" && delta.content !== "") {
      totalContent += delta.content;
      contentChunkCount += 1;
    }
    const reason = chunk.choices?.[0]?.finish_reason;
    if (reason) {
      finishReason = reason;
    }
  }

  ok("received at least one chunk", chunkCount > 0);
  ok("first chunk sets role='assistant'", firstChunkRole === "assistant");
  ok("finish_reason is 'stop'", finishReason === "stop");
  ok("accumulated content is non-empty", totalContent.length > 0);
  ok("model field present in chunks", typeof lastModel === "string" && lastModel.length > 0);

  console.log(`  info  chunks total=${chunkCount} reasoning=${reasoningChunkCount} content=${contentChunkCount}`);
  if (totalReasoning.length > 0) {
    console.log(`  info  reasoning = ${JSON.stringify(totalReasoning)}`);
  }
  console.log(`  info  content = ${JSON.stringify(totalContent)}`);
}

async function testMultiTurnConversation(client, model) {
  section("POST /v1/chat/completions — multi-turn");

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "user", content: "My name is TestBot." },
      { role: "assistant", content: "Hello TestBot! How can I help you?" },
      { role: "user", content: "What is my name? Reply with just the name." },
    ],
    max_tokens: 20,
    temperature: 0,
    stream: false,
  });

  const content = response.choices?.[0]?.message?.content ?? "";
  ok("response references name from history",
    content.toLowerCase().includes("testbot"),
    `got: ${JSON.stringify(content)}`,
  );
}

// ──────────────────────────────────────────────
// Responses API tests
// ──────────────────────────────────────────────

async function testResponsesNonStreaming(baseUrl) {
  section("POST /v1/responses — non-streaming, string input");

  const r = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: "Reply with exactly three words: one two three",
      stream: false,
    }),
  });

  ok("status 200", r.status === 200);
  const body = await r.json();

  ok("object='response'", body?.object === "response");
  ok("id is a non-empty string", typeof body?.id === "string" && body.id.length > 0);
  ok("created_at is a positive number", typeof body?.created_at === "number" && body.created_at > 0);
  ok("model is a non-empty string", typeof body?.model === "string" && body.model.length > 0);
  ok("output is a non-empty array", Array.isArray(body?.output) && body.output.length > 0);

  const msg = body?.output?.[0];
  ok("output[0].type='message'", msg?.type === "message");
  ok("output[0].role='assistant'", msg?.role === "assistant");
  ok("output[0].status='completed'", msg?.status === "completed");
  ok("output[0].content is a non-empty array", Array.isArray(msg?.content) && msg.content.length > 0);

  const part = msg?.content?.[0];
  ok("content[0].type='output_text'", part?.type === "output_text");
  ok("content[0].text is a non-empty string", typeof part?.text === "string" && part.text.length > 0);
  ok("content[0].annotations is an array", Array.isArray(part?.annotations));

  console.log(`  info  model = ${body?.model}`);
  console.log(`  info  text = ${JSON.stringify(part?.text)}`);
}

async function testResponsesNonStreamingArrayInput(baseUrl) {
  section("POST /v1/responses — non-streaming, array input");

  const r = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: [
        { role: "user", content: "My secret word is ZEPHYR." },
        { role: "assistant", content: "Got it, I will remember ZEPHYR." },
        { role: "user", content: "What is my secret word? Reply with just the word." },
      ],
      stream: false,
    }),
  });

  ok("status 200", r.status === 200);
  const body = await r.json();

  const text = body?.output?.[0]?.content?.[0]?.text ?? "";
  ok("response references secret word from history",
    text.toUpperCase().includes("ZEPHYR"),
    `got: ${JSON.stringify(text)}`,
  );
}

async function testResponsesStreaming(baseUrl) {
  section("POST /v1/responses — streaming");

  const r = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      // input: "Count from 1 to 3, one number per line, nothing else.",
      input: "Tell me the most recent news headline you know of. Use web seacrching if needed.",
      stream: true,
    }),
  });

  ok("status 200", r.status === 200);
  ok("content-type is text/event-stream",
    r.headers.get("content-type")?.includes("text/event-stream") ?? false,
  );

  const eventNames = new Set();
  let totalDelta = "";
  let doneReceived = false;

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function processBuffer() {
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let eventName = null;
      let dataLine = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
      }

      if (dataLine === "[DONE]") {
        doneReceived = true;
        continue;
      }

      if (eventName) eventNames.add(eventName);

      if (eventName === "response.output_text.delta" && dataLine) {
        try {
          const parsed = JSON.parse(dataLine);
          if (typeof parsed?.delta === "string") totalDelta += parsed.delta;
        } catch {}
      }
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Flush any bytes held inside the decoder and process the tail
        buffer += decoder.decode();
        processBuffer();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      processBuffer();
    }
  } finally {
    reader.releaseLock();
  }

  ok("[DONE] sentinel received", doneReceived);
  ok("response.created event received", eventNames.has("response.created"));
  ok("response.output_text.delta event received", eventNames.has("response.output_text.delta"));
  ok("response.completed event received", eventNames.has("response.completed"));
  ok("accumulated delta text is non-empty", totalDelta.length > 0);

  console.log(`  info  events seen: ${[...eventNames].join(", ")}`);
  console.log(`  info  accumulated delta = ${JSON.stringify(totalDelta)}`);
}

async function testResponsesInvalidPayload(baseUrl) {
  section("POST /v1/responses — invalid payloads");

  const r1 = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: false }),
  });
  ok("missing input → 400", r1.status === 400);
  const b1 = await r1.json();
  ok("error body has error.message", typeof b1?.error?.message === "string");

  const r2 = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: 42 }),
  });
  ok("numeric input → 400", r2.status === 400);

  const r3 = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{bad json",
  });
  ok("malformed JSON → 400", r3.status === 400);
}

// ──────────────────────────────────────────────
// Chat completion error tests
// ──────────────────────────────────────────────

async function testInvalidPayloadHandling(baseUrl) {
  section("Error handling — invalid payloads");

  const r1 = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "any" }),
  });
  ok("missing messages → 400", r1.status === 400);
  const body1 = await r1.json();
  ok("error body has error.message", typeof body1?.error?.message === "string");

  const r2 = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "any", messages: [] }),
  });
  ok("empty messages → 400", r2.status === 400);

  const r3 = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  ok("malformed JSON → 400", r3.status === 400);
}

async function testCorsPreflightRequest(baseUrl) {
  section("CORS preflight");

  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3000",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,authorization",
    },
  });

  ok("OPTIONS → 204", r.status === 204);
  ok("access-control-allow-origin header present",
    r.headers.has("access-control-allow-origin"),
  );
  ok("access-control-allow-methods header present",
    r.headers.has("access-control-allow-methods"),
  );
}

async function testUnknownRoute(baseUrl) {
  section("Unknown routes");

  const r = await fetch(`${baseUrl}/not-a-real-endpoint`);
  ok("unknown route → 404", r.status === 404);
  const body = await r.json();
  ok("404 body has error.message", typeof body?.error?.message === "string");
}

// ──────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────

async function main() {
  console.log(`Proxy base URL: ${BASE_URL}`);

  const client = new OpenAI({
    baseURL: BASE_URL,
    apiKey: "venice-web-session",
  });


  let model = MODEL;
  if(!MODEL) {
    model = await testListModels(client);
  }

  if (!model) {
    throw new Error("No model available to run chat completion tests.");
  }

  console.log(`\nUsing model: ${model}`);

  await testChatCompletionNonStreaming(client, model);
  await testChatCompletionStreaming(client, model);
  await testMultiTurnConversation(client, model);
  await testResponsesNonStreaming(BASE_URL);
  await testResponsesNonStreamingArrayInput(BASE_URL);
  await testResponsesStreaming(BASE_URL);
  await testResponsesInvalidPayload(BASE_URL);
  await testInvalidPayloadHandling(BASE_URL);
  await testCorsPreflightRequest(BASE_URL);
  await testUnknownRoute(BASE_URL);

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
