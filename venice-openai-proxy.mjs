import http from "node:http";
import { VeniceWebClient } from "./venice-web-poc.mjs";

const PORT = Number(process.env.PORT || process.env.VENICE_PROXY_PORT || 3456);
const HOST = process.env.HOST || "0.0.0.0";
const CORS_ALLOW_METHODS = "GET,POST,OPTIONS";
const CORS_DEFAULT_ALLOW_HEADERS =
  "authorization,content-type,accept,origin,user-agent,x-requested-with";

function nowIso() {
  return new Date().toISOString();
}

function getTextLength(value) {
  return typeof value === "string" ? value.length : 0;
}

function collectStreamLengths(events) {
  let contentLength = 0;
  let reasoningLength = 0;

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") {
      continue;
    }

    if (event.kind === "content") {
      contentLength += getTextLength(event.content);
      reasoningLength += getTextLength(event.reasoning_content);
      continue;
    }

    if (
      event.kind === "reasoning" ||
      event.kind === "thinking" ||
      typeof event.reasoning === "string" ||
      typeof event.thinking === "string"
    ) {
      reasoningLength +=
        getTextLength(event.content) +
        getTextLength(event.reasoning) +
        getTextLength(event.thinking);
    }
  }

  return { contentLength, reasoningLength };
}

function getRequestOrigin(req) {
  return (
    req.headers.origin ||
    req.headers.referer ||
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function getRequestLength(req, bodyText = "") {
  const headerLength = Number(req.headers["content-length"]);
  if (Number.isFinite(headerLength) && headerLength >= 0) {
    return headerLength;
  }
  return Buffer.byteLength(bodyText || "", "utf8");
}

function logIncomingRequest(req, url, bodyLength = 0) {
  console.log(
    `[${nowIso()}] incoming ${req.method} ${url.pathname} origin=${getRequestOrigin(req)} length=${bodyLength}`,
  );
}

function logOutgoingResponse({
  req,
  url,
  status,
  model = null,
  contentLength = 0,
  reasoningLength = 0,
  durationMs,
  streamDurationMs = null,
}) {
  const streamPart =
    typeof streamDurationMs === "number"
      ? ` stream_ms=${streamDurationMs}`
      : "";
  const modelPart = model ? ` model=${model}` : "";
  console.log(
    `[${nowIso()}] outgoing ${req.method} ${url.pathname} status=${status}${modelPart} content_chars=${contentLength} reasoning_chars=${reasoningLength} duration_ms=${durationMs}${streamPart}`,
  );
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function corsHeaders(req) {
  const requestedHeaders = req?.headers["access-control-request-headers"];
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": CORS_ALLOW_METHODS,
    "access-control-allow-headers":
      typeof requestedHeaders === "string" && requestedHeaders.trim()
        ? requestedHeaders
        : CORS_DEFAULT_ALLOW_HEADERS,
    "access-control-max-age": "86400",
    "access-control-expose-headers": "content-type",
    vary: "access-control-request-headers",
  };
}

function applyCorsHeaders(req, res) {
  for (const [name, value] of Object.entries(corsHeaders(req))) {
    res.setHeader(name, value);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeOpenAiContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part?.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        if (part?.type === "input_text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function splitMessages(messages) {
  const prompt = [];
  const systemParts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = typeof message?.role === "string" ? message.role : "user";
    const content = normalizeOpenAiContent(message?.content);
    if (!content) {
      continue;
    }
    if (role === "system") {
      systemParts.push(content);
      continue;
    }
    if (role === "tool") {
      prompt.push({
        role: "assistant",
        content: `Tool result:\n${content}`,
      });
      continue;
    }
    prompt.push({
      role: role === "assistant" ? "assistant" : "user",
      content,
    });
  }
  return {
    prompt,
    systemPrompt: systemParts.join("\n\n"),
  };
}

function buildChatCompletionResponse({
  requestModel,
  completionId,
  text,
  created,
}) {
  return {
    id: completionId || `chatcmpl_${created}`,
    object: "chat.completion",
    created,
    model: requestModel,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
  };
}

function writeSseChunk(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function createStreamStats() {
  return {
    contentLength: 0,
    reasoningLength: 0,
  };
}

function updateStreamStats(stats, event) {
  if (!event || typeof event !== "object") {
    return;
  }

  if (event.kind === "content") {
    stats.contentLength += getTextLength(event.content);
    stats.reasoningLength += getTextLength(event.reasoning_content);
    return;
  }

  if (
    event.kind === "reasoning" ||
    event.kind === "thinking" ||
    typeof event.reasoning === "string" ||
    typeof event.thinking === "string"
  ) {
    stats.reasoningLength +=
      getTextLength(event.content) +
      getTextLength(event.reasoning) +
      getTextLength(event.thinking);
  }
}

class VeniceOpenAiProxy {
  constructor() {
    this.client = new VeniceWebClient();
    this.authPromise = null;
  }

  buildMissingSessionError() {
    return new Error(
      `No valid Venice web session found. Run "node .\\venice-login.mjs" to create ${this.client.sessionFile}.`,
    );
  }

  async ensureAuth() {
    if (!this.authPromise) {
      this.authPromise = (async () => {
        const saved = this.client.readSavedSession();
        if (!saved) {
          throw this.buildMissingSessionError();
        }

        this.client.restoreSavedSession(saved);
        if (this.client.hasUsableSavedJwt(saved)) {
          try {
            const userSession = await this.client.getUserSession(
              saved.clerkJwt,
            );
            this.client.writeSavedSession({ lastValidatedAt: Date.now() });
            return {
              source: "session",
              login: {
                signInAttemptId: null,
                sessionId: this.client.sessionId,
                clerkJwt: this.client.clerkJwt,
              },
              userSession,
            };
          } catch {
            this.client.restoreSavedSession(saved);
          }
        }

        try {
          const restored = await this.client.restoreSessionFromCookies();
          const userSession = await this.client.getUserSession(
            restored.clerkJwt,
          );
          this.client.writeSavedSession({
            lastValidatedAt: Date.now(),
            restoredAt: Date.now(),
          });
          return {
            source: restored.source,
            login: {
              signInAttemptId: null,
              sessionId: restored.sessionId,
              clerkJwt: restored.clerkJwt,
            },
            userSession,
          };
        } catch {
          throw this.buildMissingSessionError();
        }
      })().finally(() => {
        this.authPromise = null;
      });
    }
    return await this.authPromise;
  }

  async getModels(options = {}) {
    const { onlyFree = false } = options || {};
    const auth = await this.ensureAuth();
    const models = await this.client.getTextModels(auth.login.clerkJwt, {
      matureFilter: false,
      onlySafeVenice: false,
    });
    return models
      .filter(
        (model) =>
          model &&
          model.active !== false &&
          model.type === "text" &&
          (!onlyFree || model.usesCredits === false),
      )
      .map((model) => ({
        id: model.apiModelId || model.id,
        object: "model",
        created: Math.floor((model.releasedAt || Date.now()) / 1000),
        owned_by: "venice-web",
        permission: [],
        root: model.apiModelId || model.id,
        parent: null,
        venice: {
          id: model.id,
          friendly_name: model.friendly_name,
          model_traits: model.apiModelTraits || [],
        },
      }));
  }

  async chatCompletions(payload) {
    const auth = await this.ensureAuth();
    const { prompt, systemPrompt } = splitMessages(payload.messages);
    if (prompt.length === 0) {
      throw new Error("No usable prompt messages found.");
    }

    const requestId = Math.random().toString(36).slice(2, 9);
    const result = await this.client.chat(auth.login.clerkJwt, undefined, {
      model: payload.model || this.client.model,
      promptMessages: prompt,
      systemPrompt,
      requestId,
    });
    return result;
  }

  async openChatCompletionStream(payload) {
    const auth = await this.ensureAuth();
    const { prompt, systemPrompt } = splitMessages(payload.messages);
    if (prompt.length === 0) {
      throw new Error("No usable prompt messages found.");
    }

    const requestId = Math.random().toString(36).slice(2, 9);
    return await this.client.openChatStream(auth.login.clerkJwt, undefined, {
      model: payload.model || this.client.model,
      promptMessages: prompt,
      systemPrompt,
      requestId,
    });
  }
}

export function createVeniceOpenAiProxy() {
  return new VeniceOpenAiProxy();
}

export function createVeniceOpenAiProxyServer(
  proxy = createVeniceOpenAiProxy(),
) {
  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    applyCorsHeaders(req, res);
    try {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`,
      );

      if (req.method === "OPTIONS") {
        logIncomingRequest(req, url, 0);
        res.writeHead(204);
        res.end();
        logOutgoingResponse({
          req,
          url,
          status: 204,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      if (
        req.method === "GET" &&
        (url.pathname === "/models" || url.pathname === "/v1/models")
      ) {
        logIncomingRequest(req, url, 0);
        const data = await proxy.getModels({ onlyFree: true });
        json(res, 200, { object: "list", data });
        logOutgoingResponse({
          req,
          url,
          status: 200,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      if (
        req.method === "POST" &&
        (url.pathname === "/chat/completions" ||
          url.pathname === "/v1/chat/completions")
      ) {
        const bodyText = await readBody(req);
        logIncomingRequest(req, url, getRequestLength(req, bodyText));
        const payload = safeJsonParse(bodyText);
        if (!payload || typeof payload !== "object") {
          json(res, 400, {
            error: {
              message: "Invalid JSON body",
              type: "invalid_request_error",
            },
          });
          logOutgoingResponse({
            req,
            url,
            status: 400,
            durationMs: Date.now() - startedAt,
          });
          return;
        }
        if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
          json(res, 400, {
            error: {
              message: "`messages` is required",
              type: "invalid_request_error",
            },
          });
          logOutgoingResponse({
            req,
            url,
            status: 400,
            durationMs: Date.now() - startedAt,
          });
          return;
        }

        if (payload.stream) {
          const streamStartedAt = Date.now();
          const created = Math.floor(Date.now() / 1000);
          let completionId = `chatcmpl_${created}`;
          let servingModelId = payload.model || proxy.client.model;
          let roleChunkSent = false;
          const stats = createStreamStats();
          const stream = await proxy.openChatCompletionStream(payload);

          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });

          try {
            for await (const event of stream.events) {
              updateStreamStats(stats, event);

              if (
                event?.kind === "meta" &&
                typeof event.completion_id === "string"
              ) {
                completionId = event.completion_id;
              }
              if (
                event?.kind === "meta" &&
                typeof event.servingModelId === "string"
              ) {
                servingModelId = event.servingModelId;
              }

              if (!roleChunkSent) {
                writeSseChunk(res, {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: servingModelId,
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant" },
                      finish_reason: null,
                    },
                  ],
                });
                roleChunkSent = true;
              }

              if (event?.kind !== "content" || !event.content) {
                continue;
              }

              writeSseChunk(res, {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: servingModelId,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.content },
                    finish_reason: null,
                  },
                ],
              });
            }

            if (!roleChunkSent) {
              writeSseChunk(res, {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: servingModelId,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant" },
                    finish_reason: null,
                  },
                ],
              });
            }

            writeSseChunk(res, {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: servingModelId,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            });
            res.write("data: [DONE]\n\n");
            res.end();
            logOutgoingResponse({
              req,
              url,
              status: 200,
              model: servingModelId,
              contentLength: stats.contentLength,
              reasoningLength: stats.reasoningLength,
              durationMs: Date.now() - startedAt,
              streamDurationMs: Date.now() - streamStartedAt,
            });
            return;
          } catch (error) {
            if (!res.headersSent) {
              throw error;
            }
            res.end();
            logOutgoingResponse({
              req,
              url,
              status: 200,
              model: servingModelId,
              contentLength: stats.contentLength,
              reasoningLength: stats.reasoningLength,
              durationMs: Date.now() - startedAt,
              streamDurationMs: Date.now() - streamStartedAt,
            });
            return;
          }
        }

        const result = await proxy.chatCompletions(payload);
        const created = Math.floor(Date.now() / 1000);
        const completionId =
          result.events.find(
            (event) => event?.kind === "meta" && event?.completion_id,
          )?.completion_id || `chatcmpl_${created}`;
        const servingModelId =
          result.events.find(
            (event) => event?.kind === "meta" && event?.servingModelId,
          )?.servingModelId || payload.model;
        const lengths = collectStreamLengths(result.events);

        json(
          res,
          200,
          buildChatCompletionResponse({
            requestModel: servingModelId,
            completionId,
            text: result.text,
            created,
          }),
        );
        logOutgoingResponse({
          req,
          url,
          status: 200,
          model: servingModelId,
          contentLength: lengths.contentLength,
          reasoningLength: lengths.reasoningLength,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      logIncomingRequest(req, url, 0);
      json(res, 404, {
        error: { message: "Not found", type: "invalid_request_error" },
      });
      logOutgoingResponse({
        req,
        url,
        status: 404,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`,
      );
      if (res.headersSent) {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      json(res, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "server_error",
        },
      });
      logOutgoingResponse({
        req,
        url,
        status: 500,
        durationMs: Date.now() - startedAt,
      });
    }
  });
}

export function startVeniceOpenAiProxyServer({
  host = HOST,
  port = PORT,
  proxy = createVeniceOpenAiProxy(),
} = {}) {
  const server = createVeniceOpenAiProxyServer(proxy);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve({ server, proxy, host, port });
    });
  });
}

async function main() {
  const { host, port } = await startVeniceOpenAiProxyServer();
  console.log(`Venice OpenAI proxy listening on http://${host}:${port}`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
