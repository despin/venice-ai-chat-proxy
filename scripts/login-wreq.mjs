import crypto from "node:crypto";
import fs from "node:fs";
import { createSession } from "wreq-js";

const VENICE_ORIGIN = "https://venice.ai";
const CLERK_BASE_URL = "https://clerk.venice.ai";
const OUTFACE_BASE_URL = "https://outerface.venice.ai";
const CLERK_API_VERSION = "2025-11-10";
const CLERK_JS_VERSION = "5.125.10";
const VENICE_VERSION = "interface@20260429.025033+f3675fb";
const MIDDLEFACE_VERSION = "0.1.692";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const SIGN_IN_URL =
  `${VENICE_ORIGIN}/sign-in#/?` +
  "sign_up_force_redirect_url=https%3A%2F%2Fvenice.ai%2Fsign-up-migration&" +
  "sign_in_force_redirect_url=https%3A%2F%2Fvenice.ai%2Fchat&" +
  "redirect_url=https%3A%2F%2Fvenice.ai%2Fchat";

function nowMs() {
  return Date.now();
}

function decodeJwtPayload(jwt) {
  try {
    const [, payload] = jwt.split(".");
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function browserHeaders(extra = {}) {
  return {
    "user-agent": USER_AGENT,
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    ...extra,
  };
}

async function readJsonResponse(response) {
  let data = null;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (response.status < 200 || response.status >= 300) {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
  return data;
}

async function readFetchJsonResponse(response) {
  let data = null;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (response.status < 200 || response.status >= 300) {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
  return data;
}

function exportCookies(session) {
  return session.getAllCookies().map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || "",
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    hostOnly: !String(cookie.domain || "").startsWith("."),
    expiresAt:
      typeof cookie.expiresAtMs === "number" && Number.isFinite(cookie.expiresAtMs)
        ? cookie.expiresAtMs
        : null,
  }));
}

export async function loginWithWreq({ email, password, sessionFile }) {
  const clerkQuery =
    `__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`;
  const session = await createSession({
    browser: process.env.VENICE_WREQ_BROWSER || "chrome_131",
    os: process.env.VENICE_WREQ_OS || "macos",
    defaultHeaders: browserHeaders(),
  });

  try {
    await session.fetch(SIGN_IN_URL, {
      headers: browserHeaders({
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        referer: `${VENICE_ORIGIN}/`,
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
      }),
    });
    await session.fetch(`${VENICE_ORIGIN}/api/auth/session`, {
      headers: browserHeaders({
        "content-type": "application/json",
        referer: `${VENICE_ORIGIN}/sign-in`,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      }),
    });
    await readJsonResponse(
      await session.fetch(`${CLERK_BASE_URL}/v1/environment?${clerkQuery}`, {
        headers: browserHeaders({
          origin: VENICE_ORIGIN,
          referer: `${VENICE_ORIGIN}/`,
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
        }),
      }),
    );
    await readJsonResponse(
      await session.fetch(`${CLERK_BASE_URL}/v1/client?${clerkQuery}`, {
        headers: browserHeaders({
          origin: VENICE_ORIGIN,
          referer: `${VENICE_ORIGIN}/`,
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
        }),
      }),
    );

    const signIn = await readJsonResponse(
      await session.fetch(`${CLERK_BASE_URL}/v1/client/sign_ins?${clerkQuery}`, {
        method: "POST",
        headers: browserHeaders({
          "content-type": "application/x-www-form-urlencoded",
          origin: VENICE_ORIGIN,
          referer: `${VENICE_ORIGIN}/`,
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
          priority: "u=1, i",
        }),
        body: new URLSearchParams({ locale: "en-US", identifier: email }),
      }),
    );
    const signInAttemptId =
      signIn?.response?.id || signIn?.client?.sign_in?.id;
    if (!signInAttemptId) {
      throw new Error("Could not resolve Clerk sign-in attempt id.");
    }

    const verification = await readJsonResponse(
      await session.fetch(
        `${CLERK_BASE_URL}/v1/client/sign_ins/${encodeURIComponent(signInAttemptId)}/attempt_first_factor?${clerkQuery}`,
        {
          method: "POST",
          headers: browserHeaders({
            "content-type": "application/x-www-form-urlencoded",
            origin: VENICE_ORIGIN,
            referer: `${VENICE_ORIGIN}/`,
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
            priority: "u=1, i",
          }),
          body: new URLSearchParams({ strategy: "password", password }),
        },
      ),
    );
    const response = verification?.response ?? {};
    const sessionId = response.created_session_id;
    const userId =
      response.created_user_id ||
      verification?.client?.sessions?.[0]?.user?.id ||
      response?.user_data?.id;
    if (!sessionId) {
      throw new Error("Could not resolve Clerk session id.");
    }

    await session.fetch(`${VENICE_ORIGIN}/sign-in/continue`, {
      method: "POST",
      headers: browserHeaders({
        accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        origin: VENICE_ORIGIN,
        referer: `${VENICE_ORIGIN}/sign-in/continue`,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      }),
      body: "[]",
    });

    const touched = await readJsonResponse(
      await session.fetch(
        `${CLERK_BASE_URL}/v1/client/sessions/${encodeURIComponent(sessionId)}/touch?${clerkQuery}`,
        {
          method: "POST",
          headers: browserHeaders({
            "content-type": "application/x-www-form-urlencoded",
            origin: VENICE_ORIGIN,
            referer: `${VENICE_ORIGIN}/`,
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
            priority: "u=1, i",
          }),
          body: new URLSearchParams({
            active_organization_id: "",
            intent: "select_session",
          }),
        },
      ),
    );
    const clerkJwt = touched?.response?.last_active_token?.jwt;
    if (!clerkJwt) {
      throw new Error("Could not resolve Clerk session JWT from touch response.");
    }

    const distinctId = crypto.randomUUID();
    const userSession = await readFetchJsonResponse(
      await fetch(`${OUTFACE_BASE_URL}/api/user/session`, {
        headers: browserHeaders({
          authorization: `Bearer ${clerkJwt}`,
          origin: VENICE_ORIGIN,
          referer: `${VENICE_ORIGIN}/`,
          "x-venice-distinct-id": distinctId,
          "x-venice-locale": "en",
          "x-venice-request-timestamp-ms": String(nowMs()),
          "x-venice-version": VENICE_VERSION,
          "x-venice-middleface-version": MIDDLEFACE_VERSION,
        }),
      }),
    );

    const payload = decodeJwtPayload(clerkJwt);
    const snapshot = {
      savedAt: nowMs(),
      sessionFile,
      email,
      sessionId,
      clerkJwt,
      clerkJwtExpiresAt: typeof payload.exp === "number" ? payload.exp * 1000 : null,
      userId: userId || userSession?.userId || userSession?.authSystemUserId,
      userDistinctId: userSession?.id || userSession?.user?.id || distinctId,
      deviceDistinctId: distinctId,
      veniceVersion: VENICE_VERSION,
      middlefaceVersion: MIDDLEFACE_VERSION,
      cookies: exportCookies(session),
      lastValidatedAt: nowMs(),
      loginMethod: "wreq-js",
    };
    fs.writeFileSync(sessionFile, JSON.stringify(snapshot, null, 2));

    return {
      ok: true,
      source: "login",
      sessionFile,
      email: userSession?.email || email,
      sessionId,
      clerkJwtPreview: `${clerkJwt.slice(0, 24)}...`,
      hasOuterfaceToken: Boolean(userSession?.token),
      canPost: userSession?.canPost,
    };
  } finally {
    await session.close();
  }
}
