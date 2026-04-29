import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VENICE_ORIGIN = "https://venice.ai";
const CLERK_BASE_URL = "https://clerk.venice.ai";
const OUTFACE_BASE_URL = "https://outerface.venice.ai";
const CLERK_API_VERSION = "2025-11-10";
const CLERK_JS_VERSION = "5.125.10";
const DEFAULT_MODEL = "zai-org-glm-4.6";
const DEFAULT_PROMPT = "Doing inference!";
const DEFAULT_VENICE_VERSION = "interface@20260429.025033+f3675fb";
const DEFAULT_MIDDLEFACE_VERSION = "0.1.692";
const DEFAULT_SESSION_FILE = path.join(process.cwd(), ".venice-web-session.json");
const LOGIN_CONFIG_FILE = path.join(process.cwd(), "venice-login.json");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const BROWSER_CLIENT_HINT_HEADERS = {
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};
const BROWSER_CORS_HEADERS = {
  ...BROWSER_CLIENT_HINT_HEADERS,
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
};

let cachedLoginConfig;

function readLoginConfig() {
  if (cachedLoginConfig !== undefined) {
    return cachedLoginConfig;
  }
  try {
    cachedLoginConfig = JSON.parse(fs.readFileSync(LOGIN_CONFIG_FILE, "utf8"));
  } catch {
    cachedLoginConfig = {};
  }
  return cachedLoginConfig;
}

function credentialValue(name) {
  const envValue = process.env[name];
  if (typeof envValue === "string" && envValue.trim()) {
    return name.endsWith("PASSWORD") ? envValue : envValue.trim();
  }

  const fileValue = readLoginConfig()[name];
  if (typeof fileValue === "string" && fileValue.trim()) {
    return name.endsWith("PASSWORD") ? fileValue : fileValue.trim();
  }
  return "";
}

function requiredCredential(name) {
  const value = credentialValue(name);
  if (!value) {
    throw new Error(`Missing required credential: ${name}`);
  }
  return value;
}

function nowMs() {
  return Date.now();
}

function toUrlEncoded(data) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    params.set(key, value ?? "");
  }
  return params.toString();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function* parseJsonLineStream(stream) {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        yield safeJsonParse(trimmed);
      }
    }

    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      yield safeJsonParse(tail);
    }
  } finally {
    reader.releaseLock();
  }
}

export function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== "string") {
    return null;
  }
  const parts = jwt.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function stripPort(hostname) {
  return hostname.replace(/:\d+$/, "");
}

function domainMatches(hostname, cookieDomain, hostOnly = false) {
  const normalizedHost = stripPort(hostname).toLowerCase();
  const normalizedDomain = cookieDomain.replace(/^\./, "").toLowerCase();
  if (hostOnly) {
    return normalizedHost === normalizedDomain;
  }
  return (
    normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`)
  );
}

class CookieJar {
  constructor() {
    this.cookies = [];
  }

  setFromResponse(urlString, response) {
    const url = new URL(urlString);
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      this.#setCookie(url, raw);
    }
  }

  getCookieHeader(urlString) {
    const url = new URL(urlString);
    const now = Date.now();
    const pairs = this.cookies
      .filter((cookie) => {
        if (cookie.expiresAt != null && cookie.expiresAt <= now) {
          return false;
        }
        if (!domainMatches(url.hostname, cookie.domain, cookie.hostOnly)) {
          return false;
        }
        return url.pathname.startsWith(cookie.path);
      })
      .map((cookie) => `${cookie.name}=${cookie.value}`);
    return pairs.length > 0 ? pairs.join("; ") : "";
  }

  debugSnapshot() {
    return this.cookies.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      expiresAt: cookie.expiresAt,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      hostOnly: cookie.hostOnly,
    }));
  }

  export() {
    return this.cookies.map((cookie) => ({ ...cookie }));
  }

  import(cookies) {
    if (!Array.isArray(cookies)) {
      return;
    }
    this.cookies = cookies
      .filter((cookie) => cookie && typeof cookie.name === "string" && typeof cookie.value === "string")
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: typeof cookie.domain === "string" ? cookie.domain : "",
        path: typeof cookie.path === "string" ? cookie.path : "/",
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        hostOnly:
          typeof cookie.hostOnly === "boolean"
            ? cookie.hostOnly
            : !String(cookie.domain ?? "").startsWith("."),
        expiresAt:
          typeof cookie.expiresAt === "number" && Number.isFinite(cookie.expiresAt)
            ? cookie.expiresAt
            : null,
      }));
  }

  #setCookie(url, raw) {
    if (!raw) {
      return;
    }
    const parts = raw.split(";").map((part) => part.trim());
    const [nameValue, ...attrs] = parts;
    const eq = nameValue.indexOf("=");
    if (eq <= 0) {
      return;
    }
    const name = nameValue.slice(0, eq);
    const value = nameValue.slice(eq + 1);
    const record = {
      name,
      value,
      domain: url.hostname,
      path: "/",
      secure: false,
      httpOnly: false,
      hostOnly: true,
      expiresAt: null,
    };

    for (const attr of attrs) {
      const attrEq = attr.indexOf("=");
      const attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
      const attrValue = attrEq === -1 ? "" : attr.slice(attrEq + 1).trim();
      switch (attrName) {
        case "domain":
          record.domain = attrValue || record.domain;
          record.hostOnly = false;
          break;
        case "path":
          record.path = attrValue || record.path;
          break;
        case "secure":
          record.secure = true;
          break;
        case "httponly":
          record.httpOnly = true;
          break;
        case "expires": {
          const parsed = Date.parse(attrValue);
          if (!Number.isNaN(parsed)) {
            record.expiresAt = parsed;
          }
          break;
        }
        case "max-age": {
          const seconds = Number(attrValue);
          if (Number.isFinite(seconds)) {
            record.expiresAt = Date.now() + seconds * 1000;
          }
          break;
        }
      }
    }

    const index = this.cookies.findIndex(
      (cookie) =>
        cookie.name === record.name &&
        cookie.domain.toLowerCase() === record.domain.toLowerCase() &&
        cookie.path === record.path,
    );
    if (index >= 0) {
      this.cookies[index] = record;
    } else {
      this.cookies.push(record);
    }
  }
}

export class VeniceWebClient {
  constructor({
    email = credentialValue("VENICE_EMAIL"),
    password = credentialValue("VENICE_PASSWORD"),
    model = process.env.VENICE_MODEL?.trim() || DEFAULT_MODEL,
    prompt = process.env.VENICE_PROMPT?.trim() || DEFAULT_PROMPT,
    sessionFile = credentialValue("VENICE_SESSION_FILE") || DEFAULT_SESSION_FILE,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("Global fetch is required.");
    }
    this.email = email;
    this.password = password;
    this.model = model;
    this.prompt = prompt;
    this.sessionFile = sessionFile;
    this.fetch = fetchImpl;
    this.cookies = new CookieJar();
    this.veniceVersion = DEFAULT_VENICE_VERSION;
    this.middlefaceVersion = DEFAULT_MIDDLEFACE_VERSION;
    this.deviceDistinctId = crypto.randomUUID();
    this.userDistinctId = null;
    this.userId = null;
    this.sessionId = null;
    this.clerkJwt = null;
  }

  async request(url, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("user-agent", USER_AGENT);
    for (const [name, value] of Object.entries(BROWSER_CLIENT_HINT_HEADERS)) {
      if (!headers.has(name)) {
        headers.set(name, value);
      }
    }
    if (!headers.has("accept")) {
      headers.set("accept", "*/*");
    }

    const cookieHeader = this.cookies.getCookieHeader(url);
    if (cookieHeader && !headers.has("cookie")) {
      headers.set("cookie", cookieHeader);
    }

    const response = await this.fetch(url, {
      ...init,
      headers,
    });

    this.cookies.setFromResponse(url, response);
    return response;
  }

  async readJson(response) {
    const text = await response.text();
    const data = text ? safeJsonParse(text) : null;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }
    return data;
  }

  async bootstrap() {
    await this.request(`${VENICE_ORIGIN}/sign-in`, {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        referer: `${VENICE_ORIGIN}/`,
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
      },
    });

    await this.request(`${VENICE_ORIGIN}/api/auth/session`, {
      headers: {
        ...BROWSER_CORS_HEADERS,
        "content-type": "application/json",
        referer: `${VENICE_ORIGIN}/sign-in`,
        "sec-fetch-site": "same-origin",
      },
    });

    await this.request(
      `${CLERK_BASE_URL}/v1/environment?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`,
      {
        headers: {
          ...BROWSER_CORS_HEADERS,
          origin: VENICE_ORIGIN,
          referer: `${VENICE_ORIGIN}/`,
          "sec-fetch-site": "same-site",
        },
      },
    );

    await this.request(
      `${CLERK_BASE_URL}/v1/client?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`,
      {
        headers: {
          ...BROWSER_CORS_HEADERS,
          origin: VENICE_ORIGIN,
          referer: `${VENICE_ORIGIN}/`,
          "sec-fetch-site": "same-site",
        },
      },
    );
  }

  async getClerkClient() {
    const response = await this.request(
      `${CLERK_BASE_URL}/v1/client?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`,
      {
        headers: {
          ...BROWSER_CORS_HEADERS,
          origin: VENICE_ORIGIN,
          referer: `${VENICE_ORIGIN}/`,
          "sec-fetch-site": "same-site",
        },
      },
    );
    return await this.readJson(response);
  }

  async startSignIn() {
    const response = await this.request(
      `${CLERK_BASE_URL}/v1/client/sign_ins?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`,
      {
        method: "POST",
        headers: {
          ...BROWSER_CORS_HEADERS,
          "content-type": "application/x-www-form-urlencoded",
          origin: VENICE_ORIGIN,
          referer: `${VENICE_ORIGIN}/`,
          "sec-fetch-site": "same-site",
        },
        body: toUrlEncoded({
          locale: "en-US",
          identifier: this.email,
        }),
      },
    );

    return await this.readJson(response);
  }

  async completePasswordSignIn(signInAttemptId) {
    const response = await this.request(
      `${CLERK_BASE_URL}/v1/client/sign_ins/${encodeURIComponent(signInAttemptId)}/attempt_first_factor?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`,
      {
        method: "POST",
        headers: {
          ...BROWSER_CORS_HEADERS,
          "content-type": "application/x-www-form-urlencoded",
          origin: VENICE_ORIGIN,
          referer: `${VENICE_ORIGIN}/`,
          "sec-fetch-site": "same-site",
        },
        body: toUrlEncoded({
          strategy: "password",
          password: this.password,
        }),
      },
    );

    return await this.readJson(response);
  }

  async continueAfterSignIn() {
    await this.request(`${VENICE_ORIGIN}/sign-in/continue`, {
      method: "POST",
      headers: {
        ...BROWSER_CORS_HEADERS,
        accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        origin: VENICE_ORIGIN,
        referer: `${VENICE_ORIGIN}/sign-in/continue`,
        "sec-fetch-site": "same-origin",
      },
      body: "[]",
    });
  }

  async touchSession(sessionId, intent = "select_session") {
    const response = await this.request(
      `${CLERK_BASE_URL}/v1/client/sessions/${encodeURIComponent(sessionId)}/touch?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`,
      {
        method: "POST",
        headers: {
          ...BROWSER_CORS_HEADERS,
          "content-type": "application/x-www-form-urlencoded",
          origin: VENICE_ORIGIN,
          referer: `${VENICE_ORIGIN}/`,
          "sec-fetch-site": "same-site",
        },
        body: toUrlEncoded({
          active_organization_id: "",
          intent,
        }),
      },
    );

    return await this.readJson(response);
  }

  async mintSessionToken(sessionId) {
    const response = await this.request(
      `${CLERK_BASE_URL}/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: VENICE_ORIGIN,
          referer: `${VENICE_ORIGIN}/`,
        },
        body: toUrlEncoded({
          organization_id: "",
        }),
      },
    );

    return await this.readJson(response);
  }

  extractClerkSession(clerkClient) {
    const sessions = clerkClient?.response?.sessions;
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return null;
    }
    const session = sessions.find((candidate) => candidate?.status === "active") ?? sessions[0];
    if (!session?.id) {
      return null;
    }
    return {
      sessionId: session.id,
      userId: session.user?.id ?? null,
      lastActiveToken: session.last_active_token?.jwt ?? null,
    };
  }

  outerfaceHeaders(jwt, extra = {}) {
    const distinctId = this.userDistinctId ?? this.deviceDistinctId;
    return {
      accept: "*/*",
      authorization: `Bearer ${jwt}`,
      origin: VENICE_ORIGIN,
      referer: `${VENICE_ORIGIN}/`,
      "x-venice-distinct-id": distinctId,
      "x-venice-locale": "en",
      "x-venice-request-timestamp-ms": String(nowMs()),
      "x-venice-version": this.veniceVersion,
      ...extra,
    };
  }

  async getUserSession(jwt) {
    const response = await this.request(`${OUTFACE_BASE_URL}/api/user/session`, {
      headers: this.outerfaceHeaders(jwt),
    });

    const data = await this.readJson(response);
    this.clerkJwt = jwt;
    this.userId = data?.userId ?? data?.authSystemUserId ?? this.userId;
    this.userDistinctId = data?.id ?? data?.user?.id ?? this.userDistinctId;
    return data;
  }

  async toggleMode(jwt, simple = false) {
    const response = await this.request(`${OUTFACE_BASE_URL}/api/user/venice_mode/toggle`, {
      method: "POST",
      headers: {
        ...this.outerfaceHeaders(jwt, {
          "content-type": "application/json",
        }),
      },
      body: JSON.stringify({ simple }),
    });

    return await this.readJson(response);
  }

  async createEmbedding(jwt, input = this.prompt) {
    const response = await this.request(`${OUTFACE_BASE_URL}/api/app/memoria/embeddings`, {
      method: "POST",
      headers: {
        ...this.outerfaceHeaders(jwt, {
          "content-type": "application/json",
        }),
      },
      body: JSON.stringify({
        input,
        encoding_format: "float",
        skipImportance: true,
      }),
    });

    return await this.readJson(response);
  }

  async getEncryptedModels(jwt, options = {}) {
    const matureFilter =
      typeof options.matureFilter === "boolean" ? String(options.matureFilter) : "false";
    const onlySafeVenice =
      typeof options.onlySafeVenice === "boolean" ? String(options.onlySafeVenice) : "false";
    const response = await this.request(
      `${OUTFACE_BASE_URL}/api/app/encrypted_models?matureFilter=${matureFilter}&onlySafeVenice=${onlySafeVenice}`,
      {
        headers: {
          ...this.outerfaceHeaders(jwt, {
            accept: "application/json, text/plain, */*",
            "x-venice-middleface-version": this.middlefaceVersion,
          }),
        },
      },
    );
    return await this.readJson(response);
  }

  async getTextModels(jwt, options = {}) {
    const encrypted = await this.getEncryptedModels(jwt, options);
    const payload = decodeJwtPayload(encrypted?.token);
    return payload?.text?.models ?? [];
  }

  async chat(jwt, input = this.prompt, options = {}) {
    const promptMessages = Array.isArray(options.promptMessages)
      ? options.promptMessages
      : [{ role: "user", content: input }];
    const response = await this.request(`${OUTFACE_BASE_URL}/api/inference/chat`, {
      method: "POST",
      headers: {
        ...this.outerfaceHeaders(jwt, {
          accept: "text/event-stream",
          "content-type": "application/json",
          "x-venice-middleface-version": this.middlefaceVersion,
        }),
      },
      body: JSON.stringify({
        clientProcessingTime: 0,
        conversationType: "text",
        includeVeniceSystemPrompt: true,
        isCharacter: false,
        modelId: options.model || this.model,
        prompt: promptMessages,
        reasoning: Boolean(options.reasoning),
        requestId: options.requestId || crypto.randomBytes(4).toString("base64url"),
        simpleMode: false,
        systemPrompt: options.systemPrompt || "",
        userId: this.userId,
        webEnabled: true,
        webScrapeEnabled: false,
        xSearchEnabled: false,
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const events = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => safeJsonParse(line));

    return {
      raw: text,
      events,
      text: events
        .filter((event) => event && typeof event === "object" && event.kind === "content")
        .map((event) => event.content ?? "")
        .join(""),
    };
  }

  async openChatStream(jwt, input = this.prompt, options = {}) {
    const promptMessages = Array.isArray(options.promptMessages)
      ? options.promptMessages
      : [{ role: "user", content: input }];
    const response = await this.request(`${OUTFACE_BASE_URL}/api/inference/chat`, {
      method: "POST",
      headers: {
        ...this.outerfaceHeaders(jwt, {
          accept: "text/event-stream",
          "content-type": "application/json",
          "x-venice-middleface-version": this.middlefaceVersion,
        }),
      },
      body: JSON.stringify({
        clientProcessingTime: 0,
        conversationType: "text",
        includeVeniceSystemPrompt: true,
        isCharacter: false,
        modelId: options.model || this.model,
        prompt: promptMessages,
        reasoning: Boolean(options.reasoning),
        requestId: options.requestId || crypto.randomBytes(4).toString("base64url"),
        simpleMode: false,
        systemPrompt: options.systemPrompt || "",
        userId: this.userId,
        webEnabled: true,
        webScrapeEnabled: false,
        xSearchEnabled: false,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return {
      response,
      events: parseJsonLineStream(response.body),
    };
  }

  async login() {
    if (!this.email) {
      this.email = requiredCredential("VENICE_EMAIL");
    }
    if (!this.password) {
      this.password = requiredCredential("VENICE_PASSWORD");
    }

    await this.bootstrap();

    const signIn = await this.startSignIn();
    const signInAttemptId = signIn?.response?.id ?? signIn?.client?.sign_in?.id;
    if (!signInAttemptId) {
      throw new Error(`Could not resolve Clerk sign-in attempt id: ${JSON.stringify(signIn)}`);
    }

    const verification = await this.completePasswordSignIn(signInAttemptId);
    const sessionId = verification?.response?.created_session_id;
    const userId =
      verification?.response?.created_user_id ??
      verification?.client?.sessions?.[0]?.user?.id ??
      verification?.response?.user_data?.id;
    if (!sessionId) {
      throw new Error(`Could not resolve Clerk session id: ${JSON.stringify(verification)}`);
    }
    if (userId) {
      this.userId = userId;
    }
    this.sessionId = sessionId;

    await this.continueAfterSignIn();
    const touched = await this.touchSession(sessionId);
    let jwt = touched?.response?.last_active_token?.jwt;
    let tokenResponse = null;
    if (!jwt) {
      tokenResponse = await this.mintSessionToken(sessionId);
      jwt = tokenResponse?.jwt;
    }
    if (!jwt) {
      throw new Error(`Could not mint Clerk session JWT: ${JSON.stringify(tokenResponse)}`);
    }

    this.clerkJwt = jwt;

    return {
      signInAttemptId,
      sessionId,
      clerkJwt: jwt,
    };
  }

  async restoreSessionFromCookies() {
    await this.bootstrap();
    const clerkClient = await this.getClerkClient();
    const restored = this.extractClerkSession(clerkClient);
    if (!restored?.sessionId) {
      throw new Error("No active Clerk session found in saved browser cookies.");
    }

    this.sessionId = restored.sessionId;
    if (restored.userId) {
      this.userId = restored.userId;
    }

    let jwt = restored.lastActiveToken;
    const payload = decodeJwtPayload(jwt);
    const expiresAt = typeof payload?.exp === "number" ? payload.exp * 1000 : null;
    if (!jwt || !expiresAt || expiresAt <= nowMs() + 30_000) {
      const touched = await this.touchSession(restored.sessionId);
      jwt = touched?.response?.last_active_token?.jwt ?? null;
      if (!jwt) {
        const tokenResponse = await this.mintSessionToken(restored.sessionId);
        jwt = tokenResponse?.jwt ?? null;
      }
    }

    if (!jwt) {
      throw new Error("Could not mint a Clerk session JWT from saved cookies.");
    }

    this.clerkJwt = jwt;
    return {
      sessionId: restored.sessionId,
      clerkJwt: jwt,
      source: "cookie-restore",
    };
  }

  readSavedSession() {
    if (!this.sessionFile || !fs.existsSync(this.sessionFile)) {
      return null;
    }
    try {
      return safeJsonParse(fs.readFileSync(this.sessionFile, "utf8"));
    } catch {
      return null;
    }
  }

  writeSavedSession(extra = {}) {
    const payload = decodeJwtPayload(this.clerkJwt);
    const expiresAt = typeof payload?.exp === "number" ? payload.exp * 1000 : null;
    const snapshot = {
      savedAt: nowMs(),
      sessionFile: this.sessionFile,
      email: this.email,
      sessionId: this.sessionId,
      clerkJwt: this.clerkJwt,
      clerkJwtExpiresAt: expiresAt,
      userId: this.userId,
      userDistinctId: this.userDistinctId,
      deviceDistinctId: this.deviceDistinctId,
      veniceVersion: this.veniceVersion,
      middlefaceVersion: this.middlefaceVersion,
      cookies: this.cookies.export(),
      ...extra,
    };
    fs.writeFileSync(this.sessionFile, JSON.stringify(snapshot, null, 2));
    return snapshot;
  }

  clearSavedSession() {
    if (this.sessionFile && fs.existsSync(this.sessionFile)) {
      fs.unlinkSync(this.sessionFile);
    }
  }

  restoreSavedSession(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return;
    }
    this.sessionId = typeof snapshot.sessionId === "string" ? snapshot.sessionId : null;
    this.clerkJwt = typeof snapshot.clerkJwt === "string" ? snapshot.clerkJwt : null;
    this.userId = typeof snapshot.userId === "string" ? snapshot.userId : null;
    this.userDistinctId =
      typeof snapshot.userDistinctId === "string" ? snapshot.userDistinctId : null;
    this.deviceDistinctId =
      typeof snapshot.deviceDistinctId === "string" ? snapshot.deviceDistinctId : this.deviceDistinctId;
    this.veniceVersion =
      typeof snapshot.veniceVersion === "string" ? snapshot.veniceVersion : this.veniceVersion;
    this.middlefaceVersion =
      typeof snapshot.middlefaceVersion === "string"
        ? snapshot.middlefaceVersion
        : this.middlefaceVersion;
    this.cookies.import(snapshot.cookies);
  }

  hasUsableSavedJwt(snapshot) {
    const jwt = snapshot?.clerkJwt;
    if (typeof jwt !== "string" || !jwt) {
      return false;
    }
    const payload = decodeJwtPayload(jwt);
    if (!payload || typeof payload.exp !== "number") {
      return false;
    }
    return payload.exp * 1000 > nowMs() + 30_000;
  }

  async ensureAuthenticated() {
    const saved = this.readSavedSession();
    if (saved && this.hasUsableSavedJwt(saved)) {
      this.restoreSavedSession(saved);
      try {
        const userSession = await this.getUserSession(saved.clerkJwt);
        this.writeSavedSession({ lastValidatedAt: nowMs() });
        return {
          source: "session",
          login: {
            signInAttemptId: null,
            sessionId: this.sessionId,
            clerkJwt: this.clerkJwt,
          },
          userSession,
        };
      } catch {
        this.clearSavedSession();
      }
    }

    if (saved) {
      this.restoreSavedSession(saved);
      try {
        const restored = await this.restoreSessionFromCookies();
        const userSession = await this.getUserSession(restored.clerkJwt);
        this.writeSavedSession({ lastValidatedAt: nowMs(), restoredAt: nowMs() });
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
        this.clearSavedSession();
      }
    }

    const login = await this.login();
    const userSession = await this.getUserSession(login.clerkJwt);
    this.writeSavedSession({ lastValidatedAt: nowMs() });
    return {
      source: "login",
      login,
      userSession,
    };
  }
}

async function main() {
  const client = new VeniceWebClient();

  const auth = await client.ensureAuthenticated();
  await client.toggleMode(auth.login.clerkJwt, false);
  const embedding = await client.createEmbedding(auth.login.clerkJwt);
  const completion = await client.chat(auth.login.clerkJwt);

  console.log(JSON.stringify(
    {
      authSource: auth.source,
      login: {
        signInAttemptId: auth.login.signInAttemptId,
        sessionId: auth.login.sessionId,
        clerkJwtPreview: `${auth.login.clerkJwt.slice(0, 24)}...`,
      },
      userSession: {
        email: auth.userSession?.email,
        canPost: auth.userSession?.canPost,
        hasOuterfaceToken: Boolean(auth.userSession?.token),
      },
      embedding: {
        model: embedding?.model,
        promptTokens: embedding?.usage?.prompt_tokens,
      },
      chat: {
        model: client.model,
        prompt: client.prompt,
        text: completion.text,
        eventCount: completion.events.length,
      },
      sessionFile: client.sessionFile,
      cookies: client.cookies.debugSnapshot(),
    },
    null,
    2,
  ));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
