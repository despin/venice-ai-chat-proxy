import readline from "node:readline";
import { access, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { VeniceWebClient } from "./venice-web-poc.mjs";

const CREDENTIALS_FILE = new URL("./venice-login.json", import.meta.url);
const CURL_CFFI_LOGIN = new URL("./venice-login-curl-cffi.py", import.meta.url);
const LOCAL_VENV_DIR = new URL("./.venice-login-venv/", import.meta.url);
const LOCAL_VENV_PYTHON =
  process.platform === "win32"
    ? new URL("Scripts/python.exe", LOCAL_VENV_DIR)
    : new URL("bin/python", LOCAL_VENV_DIR);

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

function runProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function processSucceeds(command, args, env = process.env) {
  try {
    await runProcess(command, args, env);
    return true;
  } catch {
    return false;
  }
}

async function ensureCurlCffiPython() {
  const configured = process.env.VENICE_PYTHON?.trim() || process.env.PYTHON?.trim();
  const candidates = [
    configured,
    LOCAL_VENV_PYTHON.pathname,
    "python3",
    "python",
  ].filter(Boolean);

  for (const python of candidates) {
    if (await processSucceeds(python, ["-c", "import curl_cffi"])) {
      return python;
    }
  }

  const bootstrapPython = configured || "python3";
  await mkdir(LOCAL_VENV_DIR, { recursive: true });
  await runProcess(bootstrapPython, ["-m", "venv", LOCAL_VENV_DIR.pathname], process.env);
  const venvPython = LOCAL_VENV_PYTHON.pathname;
  await access(venvPython);
  await runProcess(
    venvPython,
    ["-m", "pip", "install", "--upgrade", "pip", "curl_cffi"],
    process.env,
  );
  return venvPython;
}

async function loginWithCurlCffi({ email, password, sessionFile }) {
  const python = await ensureCurlCffiPython();
  const stdout = await runProcess(
    python,
    [CURL_CFFI_LOGIN.pathname],
    {
      ...process.env,
      VENICE_EMAIL: email,
      VENICE_PASSWORD: password,
      ...(sessionFile ? { VENICE_SESSION_FILE: sessionFile } : {}),
    },
  );
  return JSON.parse(stdout);
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

async function main() {
  const restoreFlag = process.argv.includes("--restore");
  const restoreOnlyFlag = process.argv.includes("--restore-only");
  const directOnly = process.argv.includes("--direct");
  const credentials = await readCredentialsFile();
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
        : await loginWithCurlCffi({ email, password, sessionFile: client.sessionFile });

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
