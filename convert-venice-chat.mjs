import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_MODEL = process.env.VENICE_IMPORT_MODEL?.trim() || "venice-web";
const DEFAULT_DATE_ORDER = (process.env.VENICE_DATE_ORDER?.trim() || "DMY").toUpperCase();

function usage() {
  console.error(
    "Usage: node .\\convert-venice-chat.mjs <input.txt> [output.json]",
  );
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[^\n]*\r?\n([\s\S]*?)\r?\n```$/);
  return match ? match[1] : text;
}

function normalizeRole(label) {
  const value = String(label || "").trim().toLowerCase();
  if (["tú", "tu", "user", "usuario", "human"].includes(value)) {
    return "user";
  }
  if (["asistente", "assistant", "ai", "model"].includes(value)) {
    return "assistant";
  }
  return "user";
}

function parseTimestamp(raw) {
  const match = String(raw || "")
    .trim()
    .match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AP]M))?$/i,
    );
  if (!match) {
    return Math.floor(Date.now() / 1000);
  }

  let [, a, b, year, hour, minute, second, ampm] = match;
  let day;
  let month;
  if (DEFAULT_DATE_ORDER === "MDY") {
    month = Number(a);
    day = Number(b);
  } else {
    day = Number(a);
    month = Number(b);
  }

  let hours = Number(hour);
  if (ampm) {
    const upper = ampm.toUpperCase();
    if (upper === "AM" && hours === 12) {
      hours = 0;
    } else if (upper === "PM" && hours !== 12) {
      hours += 12;
    }
  }

  const date = new Date(
    Number(year),
    month - 1,
    day,
    hours,
    Number(minute),
    Number(second),
    0,
  );
  return Math.floor(date.getTime() / 1000);
}

function parseTranscript(text) {
  const source = stripCodeFence(text).replace(/\r\n/g, "\n");
  const headerRegex = /^\[(.+?)\]\s+([^:\n]+):\s*$/gm;
  const matches = Array.from(source.matchAll(headerRegex));
  const messages = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    const content = source.slice(start, end).trim();
    if (!content) {
      continue;
    }

    messages.push({
      role: normalizeRole(match[2]),
      content,
      timestamp: parseTimestamp(match[1]),
    });
  }

  return messages;
}

function buildImportRecord(messages, inputPath) {
  const title = path.basename(inputPath, path.extname(inputPath));
  const currentId = messages.length > 0 ? `msg_${messages.length}` : null;
  const history = {
    currentId,
    messages: {},
  };

  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];
    const id = `msg_${index + 1}`;
    const parentId = index === 0 ? null : `msg_${index}`;
    const childrenIds = index + 1 < messages.length ? [`msg_${index + 2}`] : [];
    history.messages[id] = {
      id,
      parentId,
      childrenIds,
      role: item.role,
      content: item.content,
      timestamp: item.timestamp,
    };
    if (item.role === "assistant") {
      history.messages[id].model = DEFAULT_MODEL;
      history.messages[id].done = true;
    }
  }

  const createdAt = messages[0]?.timestamp ?? Math.floor(Date.now() / 1000);
  const updatedAt = messages[messages.length - 1]?.timestamp ?? createdAt;

  return [
    {
      chat: {
        title,
        models: [DEFAULT_MODEL],
        history,
      },
      meta: {
        tags: [],
        source: "venice-conversation",
      },
      pinned: false,
      folder_id: null,
      id: crypto.randomUUID(),
      created_at: createdAt,
      updated_at: updatedAt,
    },
  ];
}

function main() {
  const inputPath = process.argv[2];
  const outputPath =
    process.argv[3] ||
    path.join(
      process.cwd(),
      `${path.basename(inputPath || "venice-conversation", path.extname(inputPath || ""))}.import.json`,
    );

  if (!inputPath) {
    usage();
    process.exitCode = 1;
    return;
  }

  const text = fs.readFileSync(inputPath, "utf8");
  const messages = parseTranscript(text);
  if (messages.length === 0) {
    throw new Error("No chat messages found in transcript.");
  }

  const payload = buildImportRecord(messages, inputPath);
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));

  console.log(`Input: ${inputPath}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Messages: ${messages.length}`);
  console.log(`Model: ${DEFAULT_MODEL}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
