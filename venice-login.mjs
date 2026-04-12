import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { VeniceWebClient } from "./venice-web-poc.mjs";

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

async function main() {
  let email;
  email = process.env.VENICE_EMAIL || await ask("Venice email: ");
  const password = process.env.VENICE_PASSWORD ||await askHidden("Venice password: ");
  const sessionFile = process.env.VENICE_SESSION_FILE?.trim();

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

  const login = await client.login();
  const userSession = await client.getUserSession(login.clerkJwt);
  client.writeSavedSession({ lastValidatedAt: Date.now() });

  console.log(
    JSON.stringify(
      {
        ok: true,
        sessionFile: client.sessionFile,
        email: userSession?.email ?? email,
        sessionId: login.sessionId,
        clerkJwtPreview: `${login.clerkJwt.slice(0, 24)}...`,
        hasOuterfaceToken: Boolean(userSession?.token),
        canPost: userSession?.canPost,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
