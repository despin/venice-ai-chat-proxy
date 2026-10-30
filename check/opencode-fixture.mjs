import fs from "node:fs";

// An opencode-like request: a ~30K-character system prompt and the tools a real
// opencode request carries. Used by check/tools.mjs (live)
// and check/tool-emulation.mjs (offline sanity of the same fixture).

export const OPENCODE_WRITE_PATH = "/tmp/opencode-check/config.js";

// Multi-line file with double and single quotes, backslashes, a regex and a
// template literal: the content GLM mangled when it mixed formats.
export const OPENCODE_WRITE_CONTENT = [
  '// config.js: "quoted" and \'single\' values',
  "export const settings = {",
  '  windowsPath: "C:\\\\Users\\\\dev\\\\project",',
  "  pattern: /^\\d{3}-\\d{4}$/,",
  '  greeting: `He said "hi" and left\\n`,',
  '  tab: "a\\tb",',
  "};",
  "",
].join("\n");

// The same file ending in a blank line ("\n\n"), to measure whether a model
// keeps trailing newlines exactly.
export const OPENCODE_WRITE_CONTENT_BLANK_END = `${OPENCODE_WRITE_CONTENT}\n`;

export function opencodeTask(content, note = "") {
  return [
    `Create the file ${OPENCODE_WRITE_PATH} with exactly the content between the BEGIN and END marker lines below.`,
    "Copy it character for character: keep every backslash, quote and newline. Call the write tool directly;",
    `do not read, list or search anything first.${note ? ` ${note}` : ""}`,
    "BEGIN",
    `${content}END`,
  ].join("\n");
}

export const OPENCODE_TASK = opencodeTask(OPENCODE_WRITE_CONTENT);

// The tools array opencode 2.2.3 really sends (captured from one request, with
// an isolated config): 12 tools, including write(path, content).
export const OPENCODE_TOOLS = JSON.parse(fs.readFileSync(new URL("./opencode-tools.json", import.meta.url), "utf8"));

const AGENT_GUIDELINES = `You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: Refuse to write code or explain code that may be used maliciously. Before you begin work, think about what the code you're editing is supposed to do based on the filenames and directory structure.

# Tone and style
You should be concise, direct, and to the point. When you run a non-trivial bash command, you should explain what the command does and why you are running it. Your output will be displayed on a command line interface. Your responses can use GitHub-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.
Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like bash or code comments as means to communicate with the user during the session.
If you cannot or will not help the user with something, please do not say why or what it could lead to. Keep your responses short, since they will be displayed on a command line interface. You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless the user asks for detail.

# Proactiveness
You are allowed to be proactive, but only when the user asks you to do something. Strike a balance between doing the right thing when asked, including taking actions and follow-up actions, and not surprising the user with actions you take without asking.

# Following conventions
When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.
- NEVER assume that a given library is available, even if it is well known. Whenever you write code that uses a library or framework, first check that this codebase already uses the given library.
- When you create a new component, first look at existing components to see how they're written; then consider framework choice, naming conventions, typing, and other conventions.
- When you edit a piece of code, first look at the code's surrounding context (especially its imports) to understand the code's choice of frameworks and libraries.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys. Never commit secrets or keys to the repository.

# Code style
- IMPORTANT: DO NOT ADD ***ANY*** COMMENTS unless asked

# Doing tasks
The user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more. For these tasks the following steps are recommended:
- Use the available search tools to understand the codebase and the user's query. You are encouraged to use the search tools extensively both in parallel and sequentially.
- Implement the solution using all tools available to you
- Verify the solution if possible with tests. NEVER assume specific test framework or test script. Check the README or search codebase to determine the testing approach.
- VERY IMPORTANT: When you have completed a task, you MUST run the lint and typecheck commands (e.g. npm run lint, npm run typecheck, ruff, etc.) with Bash if they were provided to you to ensure your code is correct.
NEVER commit changes unless the user explicitly asks you to.

# Tool usage policy
- When doing file search, prefer to use the Task tool in order to reduce context usage.
- You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance.

You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail.

# Code References
When referencing specific functions or pieces of code include the pattern \`file_path:line_number\` to allow the user to easily navigate to the source code location.
`;

const ENVIRONMENT = `Here is some useful information about the environment you are running in:
<env>
  Working directory: /root/orchestra
  Is directory a git repo: yes
  Platform: linux
  Today's date: Fri Oct 30 2026
</env>
<project>
`;

const AGENTS_MD = `# AGENTS.md

## Build & test
- Install: \`pnpm install --frozen-lockfile\`
- Typecheck: \`pnpm -r typecheck\`
- Lint: \`pnpm -r lint --max-warnings=0\`
- Unit tests: \`pnpm -r test -- --run\`
- E2E: \`pnpm --filter web e2e\` (needs \`PLAYWRIGHT_BROWSERS_PATH\`)

## Conventions
- TypeScript strict mode everywhere; no \`any\` without a \`// reason:\` comment.
- Prefer named exports; one React component per file; hooks live in \`src/hooks\`.
- Server code uses zod schemas at every boundary (\`src/server/schemas\`).
- Errors: throw \`AppError\` subclasses, never strings; map to HTTP in \`src/server/http.ts\`.
- SQL goes through the query builder in \`packages/db\`; no raw SQL in handlers.
- Dates are ISO strings in UTC across the wire; format only in the UI layer.
- Feature flags come from \`packages/flags\`; never read env vars in components.
- Tests sit next to the code as \`*.test.ts\`; use factories from \`packages/testing\`.
- Commit messages: imperative mood, ≤72-char subject, body explains why.

## Gotchas
- \`apps/web\` imports \`packages/ui\` source directly (no build step); restart the dev server after changing its tsconfig.
- The job runner (\`apps/worker\`) shares the DB pool size with the API: keep queries short.
- Windows paths in fixtures use escaped backslashes, e.g. \`"C:\\\\data\\\\in"\`.
`;

// A deterministic, realistic-looking repository tree to pad the prompt the way
// opencode's project context does.
function repositoryTree() {
  const areas = {
    "apps/web/src/components": ["Button", "Dialog", "Table", "Toolbar", "Sidebar", "Toast", "Tabs", "Avatar", "Badge", "Card", "Chart", "DatePicker", "Dropdown", "EmptyState", "FileUpload", "Form", "Header", "Icon", "Input", "Layout", "Menu", "Modal", "Pagination", "Popover", "Progress", "Search", "Select", "Skeleton", "Slider", "Spinner", "Stepper", "Switch", "Tag", "TextArea", "Tooltip", "Tree"],
    "apps/web/src/hooks": ["useAuth", "useDebounce", "useFeatureFlag", "useInfiniteList", "useKeyboard", "useLocalStorage", "useMediaQuery", "usePagination", "usePolling", "useToast"],
    "apps/web/src/pages": ["dashboard", "projects", "settings", "billing", "members", "audit-log", "integrations", "reports", "onboarding", "login"],
    "apps/api/src/routes": ["auth", "projects", "members", "billing", "webhooks", "reports", "search", "uploads", "audit", "health"],
    "apps/api/src/services": ["mailer", "storage", "payments", "search-index", "rate-limit", "sessions", "exports", "notifications"],
    "apps/worker/src/jobs": ["send-digest", "reindex", "cleanup-uploads", "sync-billing", "rotate-keys", "export-report", "retry-webhooks"],
    "packages/db/src/tables": ["users", "projects", "members", "invoices", "events", "api_keys", "uploads", "webhooks", "reports", "flags"],
    "packages/ui/src": ["theme", "tokens", "primitives", "icons", "motion", "layout", "typography"],
  };
  const lines = ["<files>"];
  for (const [dir, names] of Object.entries(areas)) {
    for (const name of names) {
      const ext = dir.includes("components") || dir.includes("pages") ? "tsx" : "ts";
      lines.push(`${dir}/${name}.${ext}`, `${dir}/${name}.test.${ext}`);
      if (dir.includes("components")) {
        lines.push(`${dir}/${name}.stories.tsx`, `${dir}/${name}.module.css`);
      }
    }
  }
  lines.push("</files>");
  return lines.join("\n");
}

function buildSystemPrompt() {
  let prompt = `${AGENT_GUIDELINES}\n${ENVIRONMENT}${repositoryTree()}\n</project>\n\n${AGENTS_MD}`;
  // Top up with recent-activity notes until the prompt is about 30K characters.
  for (let index = 1; prompt.length < 30_000; index += 1) {
    prompt += `\n- Session note ${index}: reviewed apps/api/src/routes/projects.ts and packages/db/src/tables/projects.ts; kept handler validation in zod, left query shapes unchanged, and ran \`pnpm -r typecheck\` before moving on.`;
  }
  return prompt;
}

export const OPENCODE_SYSTEM_PROMPT = buildSystemPrompt();
