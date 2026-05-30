import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { VeniceWebClient } from "./venice-web-poc.mjs";
import { startVeniceOpenAiProxyServer } from "./venice-openai-proxy.mjs";

function runLoginUtility(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["./venice-login.mjs", ...args], {
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
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `venice-login.mjs exited with code ${code}`));
    });
  });
}

async function main() {
  let loginOutput;
  try {
    loginOutput = await runLoginUtility(["--restore-only"]);
  } catch (error) {
    console.error(`Saved session restore failed: ${error.message}`);
    console.error("Running browserless curl_cffi login utility...");
    loginOutput = await runLoginUtility();
  }

  const client = new VeniceWebClient();
  const auth = await client.ensureAuthenticated();
  console.log(
    JSON.stringify(
      {
        ok: true,
        authSource: auth.source,
        sessionFile: process.env.VENICE_SESSION_FILE || client.sessionFile,
        sessionId: auth.login?.sessionId ?? null,
        email: auth.userSession?.email ?? client.email,
        login: JSON.parse(loginOutput),
      },
      null,
      2,
    ),
  );

  const { host, port } = await startVeniceOpenAiProxyServer();
  console.log(`Venice OpenAI proxy listening on http://${host}:${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
