import { VeniceWebClient } from "./venice-web-poc.mjs";
import { startVeniceOpenAiProxyServer } from "./venice-openai-proxy.mjs";

async function main() {
  const client = new VeniceWebClient();
  const auth = await client.ensureAuthenticated();
  console.log(
    JSON.stringify(
      {
        ok: true,
        authSource: auth.source,
        sessionFile: client.sessionFile,
        sessionId: auth.login?.sessionId ?? null,
        email: auth.userSession?.email ?? client.email,
      },
      null,
      2,
    ),
  );

  const { host, port } = await startVeniceOpenAiProxyServer();
  console.log(`Venice OpenAI proxy listening on http://${host}:${port}`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`.replace("///", "//")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
