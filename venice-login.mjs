import readline from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, rm } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { VeniceWebClient } from "./venice-web-poc.mjs";

const CREDENTIALS_FILE = new URL("./venice-login.json", import.meta.url);
const DEFAULT_SESSION_FILE = ".venice-web-session.json";

async function readCredentialsFile() {
  try {
    const credentials = JSON.parse(await readFile(CREDENTIALS_FILE, "utf8"));
    return {
      email: credentials.VENICE_EMAIL?.trim(),
      password: credentials.VENICE_PASSWORD,
      sessionFile: credentials.VENICE_SESSION_FILE?.trim(),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read ${CREDENTIALS_FILE.pathname}: ${error.message}`);
  }
}

function ask(question) {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askHidden(question) {
  const rl = readline.createInterface({ input, output, terminal: true });
  return new Promise((resolve) => {
    const originalWrite = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (stringToWrite) => {
      if (rl.stdoutMuted) {
        rl.output.write("*");
        return;
      }
      originalWrite(stringToWrite);
    };
    rl.stdoutMuted = true;
    rl.question(question, (answer) => {
      rl.output.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function loginWithWreq(options) {
  const { loginWithWreq: login } = await import("./venice-login-wreq.mjs");
  return login(options);
}

async function loginDirect(client) {
  const login = await client.login();
  const userSession = await client.getUserSession(login.clerkJwt);
  client.writeSavedSession({ lastValidatedAt: Date.now(), loginMethod: "direct-fetch" });
  return {
    ok: true,
    source: "login",
    sessionFile: client.sessionFile,
    email: userSession?.email ?? client.email,
    sessionId: login.sessionId,
    clerkJwtPreview: `${login.clerkJwt.slice(0, 24)}...`,
    hasOuterfaceToken: Boolean(userSession?.token),
    canPost: userSession?.canPost,
  };
}

async function restoreOnly(client) {
  const saved = client.readSavedSession();
  if (!saved) {
    throw new Error(`No saved Venice session found at ${client.sessionFile}.`);
  }

  if (client.hasUsableSavedJwt(saved)) {
    client.restoreSavedSession(saved);
    const userSession = await client.getUserSession(saved.clerkJwt);
    client.writeSavedSession({ lastValidatedAt: Date.now() });
    return {
      ok: true,
      source: "session",
      sessionFile: client.sessionFile,
      email: userSession?.email ?? client.email,
      sessionId: client.sessionId,
      clerkJwtPreview: `${client.clerkJwt.slice(0, 24)}...`,
      hasOuterfaceToken: Boolean(userSession?.token),
      canPost: userSession?.canPost,
    };
  }

  client.restoreSavedSession(saved);
  const restored = await client.restoreSessionFromCookies();
  const userSession = await client.getUserSession(restored.clerkJwt);
  client.writeSavedSession({ lastValidatedAt: Date.now(), restoredAt: Date.now() });
  return {
    ok: true,
    source: restored.source,
    sessionFile: client.sessionFile,
    email: userSession?.email ?? client.email,
    sessionId: restored.sessionId,
    clerkJwtPreview: `${restored.clerkJwt.slice(0, 24)}...`,
    hasOuterfaceToken: Boolean(userSession?.token),
    canPost: userSession?.canPost,
  };
}

async function restoreWithDirectFallback(client) {
  const auth = await client.ensureAuthenticated();
  return {
    ok: true,
    source: auth.source,
    sessionFile: client.sessionFile,
    email: auth.userSession?.email ?? client.email,
    sessionId: auth.login.sessionId,
    clerkJwtPreview: `${auth.login.clerkJwt.slice(0, 24)}...`,
    hasOuterfaceToken: Boolean(auth.userSession?.token),
    canPost: auth.userSession?.canPost,
  };
}

function resolveSessionFile(sessionFile) {
  return path.resolve(process.cwd(), sessionFile);
}

async function cleanSessionData(credentials) {
  const sessionFiles = new Set(
    [
      process.env.VENICE_SESSION_FILE?.trim(),
      credentials.sessionFile,
      DEFAULT_SESSION_FILE,
    ]
      .filter(Boolean)
      .map(resolveSessionFile),
  );

  const results = [];
  for (const sessionFile of sessionFiles) {
    try {
      await rm(sessionFile, { force: true });
      results.push({ sessionFile, removed: true });
    } catch (error) {
      results.push({ sessionFile, removed: false, error: error.message });
    }
  }

  return {
    ok: results.every((result) => result.removed),
    command: "clean-session",
    credentialsFile: CREDENTIALS_FILE.pathname,
    credentialsFileRemoved: false,
    results,
  };
}

async function main() {
  const cleanSessionFlag = process.argv.includes("--clean-session");
  const restoreFlag = process.argv.includes("--restore");
  const restoreOnlyFlag = process.argv.includes("--restore-only");
  const directOnly = process.argv.includes("--direct");
  const credentials = await readCredentialsFile();

  if (cleanSessionFlag) {
    console.log(JSON.stringify(await cleanSessionData(credentials), null, 2));
    return;
  }

  const email = process.env.VENICE_EMAIL?.trim() || credentials.email || await ask("Venice email: ");
  const password = process.env.VENICE_PASSWORD || credentials.password || await askHidden("Venice password: ");
  const sessionFile = process.env.VENICE_SESSION_FILE?.trim() || credentials.sessionFile;

  if (!email) {
    throw new Error("Email is required.");
  }
  if (!password) {
    throw new Error("Password is required.");
  }

  const client = new VeniceWebClient({
    email,
    password,
    ...(sessionFile ? { sessionFile } : {}),
  });

  const result = restoreOnlyFlag
    ? await restoreOnly(client)
    : restoreFlag
      ? await restoreWithDirectFallback(client)
      : directOnly
        ? await loginDirect(client)
        : await loginWithWreq({ email, password, sessionFile: client.sessionFile });

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
