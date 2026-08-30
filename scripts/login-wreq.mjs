import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSession } from "wreq-js";

const VENICE_ORIGIN = "https://venice.ai";
const CLERK_BASE_URL = "https://clerk.venice.ai";
const OUTFACE_BASE_URL = "https://outerface.venice.ai";
const CLERK_API_VERSION = "2025-11-10";
const CLERK_JS_VERSION = "5.125.10";
const VENICE_VERSION = "interface@20260429.025033+f3675fb";
const MIDDLEFACE_VERSION = "0.1.692";
const DEFAULT_MFA_STATE_FILE = path.join(process.cwd(), "venice-2fa-first-step.json");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const SIGN_IN_URL =
  `${VENICE_ORIGIN}/sign-in#/?` +
  "sign_up_force_redirect_url=https%3A%2F%2Fvenice.ai%2Fsign-up-migration&" +
  "sign_in_force_redirect_url=https%3A%2F%2Fvenice.ai%2Fchat&" +
  "redirect_url=https%3A%2F%2Fvenice.ai%2Fchat";
const CLERK_QUERY =
  `__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`;
const STRATEGIES_NEEDING_PREPARE = new Set(["email_code", "phone_code"]);

function nowMs() {
  return Date.now();
}

function mfaStateFile() {
  const configured = process.env.VENICE_MFA_STATE_FILE?.trim();
  return configured ? path.resolve(process.cwd(), configured) : DEFAULT_MFA_STATE_FILE;
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

function clerkCorsHeaders(extra = {}) {
  return browserHeaders({
    origin: VENICE_ORIGIN,
    referer: `${VENICE_ORIGIN}/`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    ...extra,
  });
}

function clerkFormHeaders() {
  return clerkCorsHeaders({
    "content-type": "application/x-www-form-urlencoded",
    priority: "u=1, i",
  });
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

// Cookies we seeded into a wreq session come back from getAllCookies() without a
// domain, so they are dropped here and the seeded entry is carried over instead.
function exportCookies(session, seedCookies = []) {
  const byKey = new Map();
  const key = (cookie) => [cookie.name, cookie.domain.toLowerCase(), cookie.path].join("|");

  for (const cookie of seedCookies) {
    if (cookie?.name && cookie.domain) {
      const record = { ...cookie, path: cookie.path || "/" };
      byKey.set(key(record), record);
    }
  }

  for (const cookie of session.getAllCookies()) {
    if (!cookie?.domain) {
      continue;
    }
    const record = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      hostOnly: !String(cookie.domain).startsWith("."),
      expiresAt:
        typeof cookie.expiresAtMs === "number" && Number.isFinite(cookie.expiresAtMs)
          ? cookie.expiresAtMs
          : null,
    };
    byKey.set(key(record), record);
  }

  return [...byKey.values()];
}

function importCookies(session, cookies) {
  if (!Array.isArray(cookies)) {
    return;
  }
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") {
      continue;
    }
    const host = String(cookie.domain || "").replace(/^\./, "");
    if (!host) {
      continue;
    }
    const cookiePath = typeof cookie.path === "string" && cookie.path ? cookie.path : "/";
    session.setCookie(cookie.name, cookie.value, `https://${host}${cookiePath}`);
  }
}

function createBrowserSession() {
  return createSession({
    browser: process.env.VENICE_WREQ_BROWSER || "chrome_131",
    os: process.env.VENICE_WREQ_OS || "macos",
    defaultHeaders: browserHeaders(),
  });
}

async function bootstrapClerk(session) {
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
    await session.fetch(`${CLERK_BASE_URL}/v1/environment?${CLERK_QUERY}`, {
      headers: clerkCorsHeaders(),
    }),
  );
  await readJsonResponse(
    await session.fetch(`${CLERK_BASE_URL}/v1/client?${CLERK_QUERY}`, {
      headers: clerkCorsHeaders(),
    }),
  );
}

function pickSecondFactor(signInAttempt) {
  const factors = Array.isArray(signInAttempt?.supported_second_factors)
    ? signInAttempt.supported_second_factors
    : [];
  if (factors.length === 0) {
    return null;
  }
  return (
    factors.find((factor) => factor?.strategy === "email_code") ??
    factors.find((factor) => factor?.strategy === "totp") ??
    factors.find((factor) => factor?.strategy === "phone_code") ??
    factors[0]
  );
}

async function prepareSecondFactor(session, signInAttemptId, factor) {
  const body = new URLSearchParams({ strategy: factor.strategy });
  if (factor.email_address_id) {
    body.set("email_address_id", factor.email_address_id);
  }
  if (factor.phone_number_id) {
    body.set("phone_number_id", factor.phone_number_id);
  }

  return await readJsonResponse(
    await session.fetch(
      `${CLERK_BASE_URL}/v1/client/sign_ins/${encodeURIComponent(signInAttemptId)}/prepare_second_factor?${CLERK_QUERY}`,
      {
        method: "POST",
        headers: clerkFormHeaders(),
        body,
      },
    ),
  );
}

async function attemptSecondFactor(session, signInAttemptId, strategy, code) {
  return await readJsonResponse(
    await session.fetch(
      `${CLERK_BASE_URL}/v1/client/sign_ins/${encodeURIComponent(signInAttemptId)}/attempt_second_factor?${CLERK_QUERY}`,
      {
        method: "POST",
        headers: clerkFormHeaders(),
        body: new URLSearchParams({ strategy, code }),
      },
    ),
  );
}

function resolveUserId(verification) {
  const response = verification?.response ?? {};
  return (
    response.created_user_id ||
    verification?.client?.sessions?.[0]?.user?.id ||
    response?.user_data?.id ||
    null
  );
}

function writeMfaState(state) {
  const file = mfaStateFile();
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  return file;
}

function readMfaState() {
  const file = mfaStateFile();
  if (!fs.existsSync(file)) {
    throw new Error(
      `No pending two-factor login found at ${file}. Run the login without --mfa-code first.`,
    );
  }
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!state?.signInAttemptId || !state?.strategy) {
    throw new Error(`Pending two-factor state at ${file} is incomplete. Re-run the login.`);
  }
  return { file, state };
}

function clearMfaState() {
  const file = mfaStateFile();
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

async function finishLogin(session, { sessionId, userId, email, sessionFile, seedCookies = [] }) {
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
      `${CLERK_BASE_URL}/v1/client/sessions/${encodeURIComponent(sessionId)}/touch?${CLERK_QUERY}`,
      {
        method: "POST",
        headers: clerkFormHeaders(),
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
    cookies: exportCookies(session, seedCookies),
    lastValidatedAt: nowMs(),
    loginMethod: "wreq-js",
  };
  fs.writeFileSync(sessionFile, JSON.stringify(snapshot, null, 2));
  clearMfaState();

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
}

export async function loginWithWreq({ email, password, sessionFile }) {
  const session = await createBrowserSession();

  try {
    await bootstrapClerk(session);

    const signIn = await readJsonResponse(
      await session.fetch(`${CLERK_BASE_URL}/v1/client/sign_ins?${CLERK_QUERY}`, {
        method: "POST",
        headers: clerkFormHeaders(),
        body: new URLSearchParams({ locale: "en-US", identifier: email }),
      }),
    );
    const signInAttemptId = signIn?.response?.id || signIn?.client?.sign_in?.id;
    if (!signInAttemptId) {
      throw new Error("Could not resolve Clerk sign-in attempt id.");
    }

    const verification = await readJsonResponse(
      await session.fetch(
        `${CLERK_BASE_URL}/v1/client/sign_ins/${encodeURIComponent(signInAttemptId)}/attempt_first_factor?${CLERK_QUERY}`,
        {
          method: "POST",
          headers: clerkFormHeaders(),
          body: new URLSearchParams({ strategy: "password", password }),
        },
      ),
    );
    const response = verification?.response ?? {};
    const userId = resolveUserId(verification);

    if (response.status === "needs_second_factor") {
      const factor = pickSecondFactor(response);
      if (!factor?.strategy) {
        throw new Error(
          "Clerk requires a second factor but did not return a supported strategy.",
        );
      }

      if (STRATEGIES_NEEDING_PREPARE.has(factor.strategy)) {
        await prepareSecondFactor(session, signInAttemptId, factor);
      }

      const stateFile = writeMfaState({
        savedAt: nowMs(),
        email,
        sessionFile,
        signInAttemptId,
        strategy: factor.strategy,
        emailAddressId: factor.email_address_id ?? null,
        phoneNumberId: factor.phone_number_id ?? null,
        safeIdentifier: factor.safe_identifier ?? null,
        userId,
        browser: process.env.VENICE_WREQ_BROWSER || "chrome_131",
        os: process.env.VENICE_WREQ_OS || "macos",
        cookies: exportCookies(session),
      });

      return {
        ok: false,
        source: "login",
        status: "needs_second_factor",
        strategy: factor.strategy,
        safeIdentifier: factor.safe_identifier ?? null,
        stateFile,
        sessionFile,
        message:
          factor.strategy === "totp"
            ? "Two-factor required. Re-run with --mfa-code <code> using your authenticator app code."
            : `Two-factor required. Venice sent a code to ${factor.safe_identifier ?? "your second factor"}. Re-run with --mfa-code <code>.`,
      };
    }

    const sessionId = response.created_session_id;
    if (!sessionId) {
      throw new Error(
        `Could not resolve Clerk session id (sign-in status: ${response.status ?? "unknown"}).`,
      );
    }

    return await finishLogin(session, { sessionId, userId, email, sessionFile });
  } finally {
    await session.close();
  }
}

export async function completeWreqMfaLogin({ code, sessionFile }) {
  if (!code) {
    throw new Error("A two-factor code is required.");
  }

  const { file, state } = readMfaState();
  const targetSessionFile = sessionFile || state.sessionFile;
  if (!targetSessionFile) {
    throw new Error(`Pending two-factor state at ${file} has no session file target.`);
  }

  const session = await createSession({
    browser: state.browser || process.env.VENICE_WREQ_BROWSER || "chrome_131",
    os: state.os || process.env.VENICE_WREQ_OS || "macos",
    defaultHeaders: browserHeaders(),
  });

  try {
    importCookies(session, state.cookies);

    const verification = await attemptSecondFactor(
      session,
      state.signInAttemptId,
      state.strategy,
      String(code).trim(),
    );
    const response = verification?.response ?? {};
    const sessionId = response.created_session_id;
    if (!sessionId) {
      throw new Error(
        `Two-factor attempt did not create a session (status: ${response.status ?? "unknown"}).`,
      );
    }

    return await finishLogin(session, {
      sessionId,
      userId: resolveUserId(verification) || state.userId || null,
      email: state.email,
      sessionFile: targetSessionFile,
      seedCookies: state.cookies,
    });
  } finally {
    await session.close();
  }
}
