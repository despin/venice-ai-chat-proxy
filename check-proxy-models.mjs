import { pathToFileURL } from "node:url";
import { startVeniceOpenAiProxyServer } from "./venice-openai-proxy.mjs";

const REPEATS = Number(process.env.CHECK_PROXY_MODELS_REPEATS || 3);

async function main() {
  const { server, host, port } = await startVeniceOpenAiProxyServer({
    host: "127.0.0.1",
    port: 0,
  });

  try {
    const address = server.address();
    const resolvedPort = typeof address === "object" && address ? address.port : port;
    const baseUrl = `http://${host}:${resolvedPort}/v1`;
    console.log(`Proxy base URL: ${baseUrl}`);
    console.log(`Requests: ${REPEATS}`);

    let lastModels = [];
    for (let attempt = 1; attempt <= REPEATS; attempt += 1) {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          accept: "application/json",
        },
      });

      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (!response.ok) {
        throw new Error(
          `Attempt ${attempt}: GET ${baseUrl}/models failed with ${response.status}: ${
            typeof data === "string" ? data : JSON.stringify(data)
          }`,
        );
      }

      lastModels = Array.isArray(data?.data) ? data.data : [];
      console.log(`Attempt ${attempt}: ${lastModels.length} models`);
    }

    for (const model of lastModels) {
      console.log(`- ${model.id}`);
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
