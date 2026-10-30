import { pathToFileURL } from "node:url";
import { createVeniceOpenAiProxy, createVeniceOpenAiProxyServer } from "../src/proxy.mjs";

// Offline check of how chat messages are sent to Venice: runs the proxy server
// with a stubbed Venice client and inspects the prompt it would send.

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

async function main() {
  const originalLog = console.log;
  const proxy = createVeniceOpenAiProxy();
  proxy.ensureAuth = async () => ({ login: { clerkJwt: "jwt" } });
  let sent = null;
  proxy.client.chat = async (_jwt, _input, options) => {
    sent = options;
    return { events: [{ kind: "content", content: "ok" }], text: "ok" };
  };

  const server = createVeniceOpenAiProxyServer(proxy);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const send = async (messages) => {
    sent = null;
    console.log = () => {};
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "zai-org-glm-5-2", messages }),
      });
      await response.text();
    } finally {
      console.log = originalLog;
    }
    return sent?.promptMessages ?? [];
  };

  try {
    section("adjacent same-role messages");

    const users = await send([
      { role: "user", content: "Remember the number 41." },
      { role: "user", content: "Add one to it." },
    ]);
    ok("two user messages become one turn",
      users.length === 1 && users[0].role === "user" && users[0].content === "Remember the number 41.\n\nAdd one to it.");

    const mixed = await send([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Check a file." },
      { role: "assistant", content: "Let me check." },
      { role: "tool", tool_call_id: "x", content: "file body" },
      { role: "user", content: "Thanks" },
      { role: "user", content: "And one more thing." },
    ]);
    ok("a tool result joins the assistant turn before it",
      mixed[1]?.role === "assistant" && mixed[1].content === "Let me check.\n\nTool result:\nfile body");
    ok("roles alternate", mixed.map((message) => message.role).join() === "user,assistant,user");
    ok("trailing user messages merged", mixed[2]?.content === "Thanks\n\nAnd one more thing.");
    ok("system messages still go to the system prompt", sent?.systemPrompt === "Be brief.");

    const alternating = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const unchanged = await send(alternating);
    ok("alternating messages are unchanged", JSON.stringify(unchanged) === JSON.stringify(alternating));

    const skipped = await send([
      { role: "user", content: "a" },
      { role: "assistant", content: null },
      { role: "user", content: "b" },
    ]);
    ok("an empty message in between still lets the neighbours merge",
      skipped.length === 1 && skipped[0].content === "a\n\nb");
  } finally {
    server.close();
  }

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
