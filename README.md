# Venice OpenAI Proxy

This project exposes the Venice web app as an OpenAI-compatible API so tools like Open WebUI can use your Venice web session without going through the official Venice API route.

It currently provides:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- streaming chat completions
- emulated OpenAI tool calling (`tools` / `tool_calls`) on `/v1/chat/completions`
- session restore using the saved Venice web session file
- request/response logging for incoming requests and streamed output sizes

## How it works

The proxy uses the Venice website login flow and session restore flow:

- Clerk auth for login and session refresh
- a persisted session file with cookies and short-lived auth state
- Venice web endpoints under `outerface.venice.ai`

The proxy translates OpenAI-style chat requests into Venice web requests, then translates the Venice response stream back into OpenAI-style SSE.

## Requirements

- Node.js 22 or newer
- a Venice account
- a saved session file, or valid `VENICE_EMAIL` and `VENICE_PASSWORD`

## Project files

Main scripts in this repo:

- `venice-openai-proxy.mjs`: OpenAI-compatible proxy server
- `venice-web-poc.mjs`: Venice web auth/session client
- `venice-login.mjs`: local login utility that creates the session file
- `venice-start.mjs`: startup entrypoint that authenticates first, then starts the proxy
- `check-proxy-models.mjs`: quick `/v1/models` smoke test
- `convert-venice-chat.mjs`: transcript-to-import JSON converter
- `docker-compose.example.yml`: example Compose setup

## Local setup

### 1. Set credentials

For local testing, edit `venice-login.json`:

```json
{
  "VENICE_EMAIL": "you@example.com",
  "VENICE_PASSWORD": "your-password",
  "VENICE_SESSION_FILE": ".venice-web-session.json"
}
```

Environment variables override values from `venice-login.json`.

PowerShell:

```powershell
$env:VENICE_EMAIL="you@example.com"
$env:VENICE_PASSWORD="your-password"
```

Optional:

```powershell
$env:VENICE_SESSION_FILE="$PWD\\.venice-web-session.json"
$env:VENICE_PROXY_PORT="3456"
```

### 2. Create or refresh the session file

```powershell
npm install
```

Then:

```powershell
node .\venice-login.mjs
```

This performs a fresh Clerk credential login without Chrome. It uses the npm package `wreq-js`, a native Node HTTP client with browser TLS/HTTP fingerprint profiles, so the network layer looks like Chrome to Clerk. It validates the Venice web session and writes `.venice-web-session.json` by default.

#### Two-factor accounts

If the account has two-factor auth enabled, Clerk answers the password step with
`needs_second_factor` instead of creating a session. The login stops there, requests the
code, and saves the pending sign-in attempt (plus its cookies) to
`venice-2fa-first-step.json`, exiting with code `2`:

```json
{
  "ok": false,
  "status": "needs_second_factor",
  "strategy": "email_code",
  "stateFile": "venice-2fa-first-step.json",
  "message": "Two-factor required. Venice sent a code to you@example.com. Re-run with --mfa-code <code>."
}
```

Then finish the login with the emailed (or authenticator) code:

```powershell
node .\scripts\login.mjs --mfa-code 123456
```

`--mfa-code` with no value prompts for the code, and `VENICE_MFA_CODE` works too. On
success the session file is written and the pending state file is deleted. Because the
saved cookies mark the device as trusted, later logins usually skip the second factor.
`VENICE_MFA_STATE_FILE` overrides the pending-state path.

Optional modes:

```powershell
node .\venice-login.mjs --restore
node .\venice-login.mjs --restore-only
node .\venice-login.mjs --direct
node .\venice-login.mjs --clean-session
```

`--restore-only` refreshes from the saved session/cookies and never falls back to credential login. `--restore` keeps the older restore/direct fallback behavior for debugging. `--direct` uses the plain Node fetch implementation, which is useful for confirming Clerk bot/rate rejection but is not the normal login path. `--clean-session` removes saved Venice session files, including the configured `VENICE_SESSION_FILE` and the default `.venice-web-session.json`, without deleting `venice-login.json`.

### Session caching

The proxy is meant to stay up for days, so it keeps the authenticated session in memory. Clerk JWTs only live about a minute; when the cached one is within `VENICE_AUTH_REFRESH_SKEW_MS` (default 10000) of expiring, the proxy mints a new one with a single Clerk `touch` using the in-memory cookies, instead of re-reading the session file and re-running the sign-in bootstrap. Requests that arrive while a JWT is still fresh do no auth work at all.

If an upstream call comes back `401` — a revoked or otherwise dead session — the cache is dropped and the request is retried once with a freshly minted JWT. Only if that refresh fails does the proxy fall back to the saved session file and cookie restore, and finally to asking you to run the login again.

### Checking the deployed build

`GET /support/info` (also `/v1/support/info`) reports which commit a running proxy is serving, so you don't have to infer it from behavior:

```bash
curl -s http://powerserver.local:3456/support/info
```

```json
{
  "ok": true,
  "service": "venice-openai-proxy",
  "build": { "commit": "e9f6594...", "commit_short": "e9f6594", "branch": "main", "source": "git" },
  "runtime": { "node": "v25.9.0", "pid": 7112, "started_at": "...", "uptime_seconds": 24 },
  "session": { "session_file": ".venice-web-session.json", "email": "you@example.com", "has_cached_auth": true, "auth_expires_at": "..." },
  "models": { "sampling_defaults_cached": 261, "loaded_at": "..." }
}
```

The commit is read straight from the checkout's `.git` (loose refs and `packed-refs` both work), with no `git` binary required. Docker images have no `.git`, so pass the commit at build time and `source` becomes `env`:

```bash
docker build --build-arg VENICE_BUILD_COMMIT=$(git rev-parse HEAD) --build-arg VENICE_BUILD_BRANCH=$(git rev-parse --abbrev-ref HEAD) -t venice-proxy .
```

The response includes the logged-in account's email, so keep the endpoint on a trusted network.

### Model sampling defaults

Venice's web client sends a per-model `temperature` and `topP` with every message; the values live in the model catalog (`GET /api/app/encrypted_models`, inside the returned JWT as `text.models[].settings`). To keep proxy output reproducible against the web UI, the proxy loads that catalog at startup and caches the defaults, re-caching them whenever `/v1/models` is called.

A request that sets `temperature` or `top_p` always wins; anything it omits falls back to the catalog value for that model. The translation log says which is which:

```
translate model="aion-labs-aion-3-0-mini" venice_model=aion-labs-aion-3-0-mini reasoning=true(model-default) venice_params={} temperature=0.6(catalog) top_p=0.9(catalog) messages=1
```

If the catalog can't be fetched at startup the proxy logs a warning and still serves; requests then fall back to Venice's own server-side defaults until the next `/v1/models` call.

### HTTP transport

Cloudflare rejects plain Node `fetch` on the Venice inference endpoints (`POST /api/inference/chat` returns a 403 challenge page), so the client sends every request through a `wreq-js` session with a Chrome TLS/HTTP fingerprint. Set `VENICE_HTTP_TRANSPORT=fetch` to force the old plain-fetch transport for debugging, and `VENICE_WREQ_BROWSER` / `VENICE_WREQ_OS` to change the impersonated profile (defaults: `chrome_131`, `macos`).

You can also run the cleanup as:

```powershell
npm run clean-session
```

### 3. Start the proxy locally

If you want the proxy only:

```powershell
node .\venice-openai-proxy.mjs
```

If you want startup auth/restore first, then the proxy:

```powershell
node .\venice-start.mjs
```

By default it listens on:

```text
http://127.0.0.1:3456/v1
```

### 4. Smoke test the models endpoint

```powershell
node .\check-proxy-models.mjs
```

That starts an internal proxy instance, calls `/v1/models`, prints the returned models, and exits.

## Open WebUI setup

In Open WebUI, add an OpenAI-compatible connection with:

- Base URL: `http://127.0.0.1:3456/v1`
- API key: any non-empty value if the UI requires one

### Model feature suffix

For clients that only let you edit the model string, the proxy supports a small
subset of Venice-style model feature suffixes:

```text
<model_id>:<parameter>=<value>&<parameter>=<value>
```

Supported parameters are:

- `includeVeniceSystemPrompt`
- `webEnabled`
- `webScrapeEnabled`
- `xSearchEnabled`

Values may be `true`/`false`, `1`/`0`, `on`/`off`, or `yes`/`no`.

Examples:

```text
qwen3-4b:includeVeniceSystemPrompt=false
qwen3-4b:webEnabled=true&webScrapeEnabled=true
qwen3-4b:webEnabled=true&xSearchEnabled=true
```

For reasoning models, the proxy also recognizes OpenAI-style
`reasoning_effort: "none"` on chat completion requests. It forwards
`reasoning: false` to Venice and prefixes the latest user message with
`/no_think `, matching Venice web behavior. Existing callers may also send
`reasoning: false` directly.

### Agent endpoint models

Some models are only served by Venice's agents endpoint
(`POST /api/inference/chat/agents/venice?agentModelId=<id>`): they are missing from the
model catalog and the plain chat endpoint does not accept them. `deepseek-v4-1-flash-free`
is one. The proxy appends these to `/v1/models` and routes them by their own id on both
`/v1/chat/completions` and `/v1/responses`, streaming or not:

```bash
curl -s http://127.0.0.1:3456/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-1-flash-free","messages":[{"role":"user","content":"hi"}]}'
```

`VENICE_AGENT_MODELS` is a comma-separated list of the ids to route this way (default
`deepseek-v4-1-flash-free`). Venice decides what actually answers: the endpoint ignores
`agentModelId`, and every id tried in a live probe (October 2026, free account) was served by
DeepSeek V4.1 Flash. The endpoint takes no sampling parameters, system prompt field, or model
feature suffix: `temperature`/`top_p` are ignored, and system messages are sent as a leading
`[System]` user message.

Tool calling is not supported on these models, or on the `agentic` alias. A request with
`tools` (unless `tool_choice` is `"none"`, or `VENICE_TOOL_EMULATION=off`) gets a 400
`invalid_request_error` with `code: "tools_not_supported"` and `param: "tools"`. A live probe
showed why:

- Venice runs no client-defined tools here. The web app's request schema has a `clientTools`
  field (`{ name, description, inputSchema }`), but a made-up client tool was not handed back
  to the caller as a `function_call` item. The model went to Venice's server-side functions
  and got "Tool not found".
- Prompt-based emulation fails for the same reason: the model reaches for the server-side
  functions instead of writing tool-call text. In the opencode-like check it succeeded in 1
  of 5 runs non-streaming and 0 of 5 streaming.

On `/v1/responses`, any other model keeps going to the older workflow endpoint with
`VENICE_AGENTIC_MODEL`. Reasoning is returned as a `reasoning` item with a summary
(`response.reasoning_summary_text.*` events when streaming), separate from the answer.

If Open WebUI runs in Docker and the proxy runs on the host, use:

- `http://host.docker.internal:3456/v1`

If both run in the same Docker Compose project, use:

- `http://venice-openai-proxy:3456/v1`

## Tool calling (emulated)

Venice's web endpoints do not accept client-defined tools, so `POST /v1/chat/completions`
emulates OpenAI function calling in the prompt. This is what lets agentic clients such as
opencode (`@ai-sdk/openai-compatible`) read files and run commands through the proxy.

How it works:

1. When a request has a non-empty `tools` array, the proxy appends a "Tools" section to the
   system prompt. It lists each tool's name, description and JSON Schema parameters and asks
   the model to answer with one block per call, in the format its model family was trained on:

   | Model id | Format | A call looks like |
   | --- | --- | --- |
   | contains `glm` | `glm` (GLM-4.5+ template) | `<tool_call>read_file`<br>`<arg_key>path</arg_key>`<br>`<arg_value>src/a.js</arg_value>`<br>`</tool_call>` |
   | Qwen3-Coder (`qwen3-coder…`) | `json` (measured, see below) | `<tool_call>{"name": "read_file", "arguments": {"path": "src/a.js"}}</tool_call>` |
   | Qwen 3.5 and later (`qwen3-5-…`, `qwen3-6-…`, `e2ee-qwen3-6-…`, `qwen-3-8-…`) | `proxy` (see below) | `<proxy_call>{"name": "read_file", "arguments": {"path": "src/a.js"}}</proxy_call>` |
   | other Qwen (`qwen3-vl-…`, Qwen3/2507, `qwen3-8b`) | `qwen` (Qwen3 / Qwen3-VL template) | `<tool_call>`<br>`{"name": "read_file", "arguments": {"path": "src/a.js"}}`<br>`</tool_call>` |
   | anything else | `json` | `<tool_call>{"name": "read_file", "arguments": {"path": "src/a.js"}}</tool_call>` |
   | opt-in only (`VENICE_TOOL_FORMATS`) | `qwen-xml` (Qwen 3.5+ template; tools listed as JSON) | same as `qwen-coder` |
   | opt-in only (`VENICE_TOOL_FORMATS`) | `qwen-coder` (Qwen3-Coder template; tools listed as XML) | `<tool_call>`<br>`<function=read_file>`<br>`<parameter=path>`<br>`src/a.js`<br>`</parameter>`<br>`</function>`<br>`</tool_call>` |

   Qwen3-Coder's native XML format lost to JSON in live runs: the opencode-like `write()` came
   back exact in 20/20 runs with `json` but 5/20 with `qwen-coder`. In XML values the model
   either JSON-escaped line breaks or, when told not to, turned a `\n` that belonged to the
   source code into a line break.

   The `proxy` format is for models whose `<tool_call>` text never reaches the proxy. A raw
   dump of Venice's response for `qwen-3-8-27b` held only `meta` and `content` events, with
   the `<tool_call>` block cut out of the text, even mid-reasoning. Venice's backend parses
   those blocks itself and drops the result, so with `qwen-xml` this model returned no calls
   at all. `qwen3-6-27b` showed the same signature: the model announced a call, then only
   whitespace (and a stray `<think></think>`) arrived, with no parser warning. No server-side
   parser knows the `<proxy_call>` tag. The prompt rules out other tool-call tags without
   naming them: when it said "never `<tool_call>`", the model repeated the tag while thinking
   and Venice cut the rest of the reply, the real `<proxy_call>` included (raw dumps of the
   empty replies show the reasoning stopping right there). Results come back as
   `<proxy_result name id>`.

   The wording and tool lists follow each family's official chat template on Hugging Face,
   and the parsing follows the matching vLLM parser. A Qwen version counts as 3.5+ only when
   followed by `-`, `.` or the end of the id: `qwen3-8b` is Qwen3 8B, not Qwen 3.8. In the
   `glm`, `qwen-xml` and `qwen-coder` formats string values are written raw and other values as
   JSON; they are converted back using each tool's JSON Schema types (`True`/`False`/`None` are
   read too). The Qwen XML template writes `<parameter=KEY>\n` + value + `\n</parameter>`, so
   that pair of wrapping newlines is removed, and only as a pair: a value written without the
   leading one keeps its trailing newline, which belongs to the content. No other format trims
   anything from a value. Tool results are rendered as `<tool_response>` blocks for the native
   formats, and as `<tool_result name id>` for `json`.
   `VENICE_TOOL_FORMATS` overrides the table with comma-separated `pattern=format` entries,
   checked before the defaults (`*` matches every model). For example,
   `VENICE_TOOL_FORMATS="glm=json,kimi=qwen-xml"` puts GLM back on the generic format and Kimi
   on Qwen 3.5+'s. Whatever format was asked for, every format is accepted in the reply.

   The section is appended to the end of your own system prompt (after the last system
   message), never instead of it. With a long client prompt (opencode sends ~36K characters)
   instructions at the end hold up best. A one-line format reminder is also appended to the
   latest user turn, which is usually the tool results.
2. History is rendered in the same format. Earlier assistant `tool_calls` become
   `<tool_call>` blocks (assistant turns with `content: null` are kept), `tool` messages become
   user turns with the result blocks, and consecutive results are merged into one turn.
3. The model's reply is scanned for `<tool_call>` blocks and returned as standard
   `tool_calls`. Ids look like `call_<hex>`, `function.arguments` is a JSON string, `content`
   is the text before the first call (or `null`), and `finish_reason` is `"tool_calls"`.
   Text after the last call is dropped. One tolerant parser reads every format, whichever was
   asked for:
   - GLM `<arg_key>`/`<arg_value>` pairs;
   - Qwen `<function=NAME><parameter=KEY>` blocks, also without the `<tool_call>` wrapper
     (Qwen3-Coder sometimes drops it) and with missing `</parameter>` or `</function>` tags;
   - JSON inside the tag, also with the name on its own line first or inside `<function=…>`;
   - hybrids where a key tag runs into JSON: `<tool_call>NAME<arg_key>key": "value", ...}` or
     `<parameter=key": "value", ...}`.

   Raw newlines and tabs inside JSON strings are escaped before parsing, and stray closing
   tags after the JSON are ignored. A block cut off at the end of the stream is still tried,
   but if its last value never closed it was truncated: it counts as unparsed (and is
   retried) rather than writing half a file.
   Fences inside the tags, `arguments` given as a string, and `parameters` instead of
   `arguments` are accepted. A reply that is nothing but a JSON call object (bare or in one
   fenced block) naming a known tool is accepted too. A call that misses an argument the
   tool's schema marks as `required` is treated as unparsed.
4. Streaming sends text as it arrives and holds back only what could be the start of a
   `<tool_call>` tag. Each call is sent as two deltas: id, type and name first, then the
   arguments. `reasoning_content` passes through and is never scanned for calls.
5. Once the reply is complete the proxy stops reading and cancels the upstream request: right
   after a call when `parallel_tool_calls` is `false`, otherwise as soon as anything other than
   another `<tool_call>` follows a call. The model cannot go on with "Let me fix that".
6. A block that cannot be parsed is never sent to the client. If no call has been returned
   yet, the proxy cancels that upstream request and retries once. The raw reply goes back to
   the model with a one-line correction in its format, and the retry's call is returned (any
   text in the retry is not shown). Only if the retry also fails does the original block come
   back as plain text. Both raw outputs are logged (`tool emulation:` warnings, truncated to
   4,000 characters). An unparsable block after a valid call is dropped. A reply with no
   text and no call is retried the same way, with the call format repeated on the latest
   user turn. Non-streaming requests work the same way: the proxy reads the upstream as a
   stream internally.

`tool_choice` is honored in the prompt: `"auto"` (default), `"required"` (must call at least
one tool), `{"type":"function","function":{"name":"X"}}` (must call `X`), and `"none"`, which
turns emulation off for that request. `parallel_tool_calls: false` asks for at most one call
and keeps only the first.

Reasoning has a budget while tools are emulated. If a reply streams more than
`VENICE_TOOL_REASONING_BUDGET` characters of reasoning (default `32000`, `0` turns it off)
before any answer text or call, the proxy cancels that upstream request. It retries once with
a note asking the model to keep its reasoning brief. If the retry runs over too, the client
gets an error instead of waiting for Venice's five-minute upstream timeout:
- non-streaming: HTTP 504 with `code: "reasoning_budget_exceeded"`. SDK clients retry a 504
  up to twice, which in live runs sometimes got an answer.
- streaming: an OpenAI-style `{"error": …}` chunk followed by `[DONE]`. Its type is
  `invalid_request_error`, although the client did nothing wrong: it is the only type that
  stops opencode's retry loop. With `server_error` or `model_error`, opencode 2.2.3 showed the
  error and re-sent the request about ten times, repeating the overrun for minutes. With this
  type it shows the message once and stops. The `openai` SDK raises it as an `APIError`. The default is about
twice the longest reasoning seen in a successful live run (16.5K characters), and a runaway
run reaches it in about a minute. Reasoning streamed before the cut has already reached the
client.

While tools are emulated, Venice's own system prompt and server-side search are turned off
for that request (`includeVeniceSystemPrompt`, `webEnabled`, `webScrapeEnabled` and
`xSearchEnabled` are sent as `false`, even when the model suffix asks for them), because they
compete with the tool instructions. The translate log shows `disabled_for_tools=…` when a
suffix setting was overridden.

Requests without `tools`, with an empty or unusable `tools` array, or with
`tool_choice: "none"` are handled exactly as before. Agent-endpoint models answer requests
with tools with a 400 (see [Agent endpoint models](#agent-endpoint-models)). Set `VENICE_TOOL_EMULATION=off` (also
`0`, `false`, `no`) to ignore `tools` entirely, the old behavior. The default is `on`.

### Tested models

Final run with `npm run check:tools` (October 2026): 5 opencode-like runs per mode, streaming
and not, plus the same 5 per mode with the file ending in a blank line, so 20 per model. The
opencode-like column counts the runs that returned the expected `write()` call with exactly
the right file content (a 30K-character system prompt, opencode's 12 tools, and content full of
quotes and backslashes), apart from trailing newlines, which are counted separately. Every
model also passed the `get_weather` round trip both ways, with no retries needed. "opencode"
means a manual session in opencode against real Venice: writing a new file, editing one (a
type check added, a function added, exports updated), writing a test file with escapes inside
a template literal, and a multi-file search.

| Model id | Format | opencode-like exact content | Trailing newlines kept | opencode | Status |
| --- | --- | --- | --- | --- | --- |
| `zai-org-glm-5-2` | `glm` | 20/20 | 19/20 | verified | recommended |
| `qwen3-coder-480b-a35b-instruct-turbo` | `json` | 20/20 | 16/20 | verified | recommended |
| `qwen-3-8-27b` | `proxy` | 20/20 | 19/20 | — | experimental |
| `qwen3-6-27b` | `proxy` | 20/20 | 20/20 | — | experimental |
| `qwen3-5-35b-a3b` | `proxy` | 20/20 | 16/20 | — | experimental |
| `e2ee-qwen3-6-35b-a3b` | `proxy` | not measured | — | — | experimental |
| `deepseek-v4-1-flash-free` and other agent-endpoint models | — | — | — | — | unsupported |

- Missing trailing newlines are the models' habit: they mostly drop a file's single final
  newline (Qwen3-Coder most often), while files ending in a blank line kept both newlines in
  almost every run. No format path trims anything from a value; the offline checks cover
  values ending in `\n` and `\n\n` in every format.
- Qwen 3.5+ stays experimental. Earlier runs, on smaller samples, showed damaged escaping
  in file content (halved backslashes, a dropped character, curly instead of straight quotes),
  another tool called first, and empty replies. The empty replies came from the model writing
  the tag Venice strips while thinking. The prompt no longer names that tag, and an empty
  reply is retried once with the format repeated. With those fixes the final run had no
  failures and no retries.
- Qwen 3.8 can get stuck reasoning; the reasoning budget below stops it.
- Agent-endpoint models answer requests with tools with a 400: Venice runs only its own
  server-side tools there (see [Agent endpoint models](#agent-endpoint-models)).

Limitations:

- It is prompt-based. Whether a call comes back depends on the model following the format,
  and `tool_choice: "required"` or a named tool can be asked for but not enforced.
- Small models may break the format. A block with invalid JSON or an unknown tool name costs
  one retry (a second upstream request); if that fails too, it is returned as plain text.
- Output-length limits can cut off large arguments, such as a whole file passed to a write
  tool. A cut-off block whose values are all complete is accepted; one cut off mid-value is
  retried once, and comes back as text if the retry fails too.
- A streamed reply that starts with `{` or a fenced JSON block is held until it ends, so it
  can be checked for an untagged call.
- Large tool schemas make the system prompt long, which costs context on every request.
- `POST /v1/responses` is not covered: its `tools` are ignored.

For requests with tools the proxy logs one
`tool emulation: ignored upstream events …` line when Venice sent anything it does not use:
other event kinds, non-JSON lines, or unexpected fields on content events.

`npm run check:tool-emulation` runs the offline checks (parser, logged model outputs, retries,
history rendering, proxy wiring against a stubbed Venice client). `npm run check:tools` runs live
checks against a running proxy (model from `CHECK_PROXY_MODEL`, default `zai-org-glm-5-2`):

- a `get_weather` round trip, streaming and not;
- requests without tools, and two user messages in a row;
- an opencode-like scenario: a ~30K-character system prompt, the 12 tools a real opencode 2.2.3
  request carries (`check/opencode-tools.json`, captured from one),
  and a `write(path, content)` whose multi-line content is full of quotes and backslashes. It
  runs `CHECK_TOOLS_OPENCODE_RUNS` times per mode (default 5), prints the success rate, and
  fails below `CHECK_TOOLS_OPENCODE_MIN_RATE` (default `0.8`). Each run prints its duration
  and how many upstream attempts the proxy needed (2 after a retry). A failed run also prints
  the first position where the file content differs, with context on both sides. A second
  round writes the same file ending in a blank line (`\n\n`). Content is scored apart from
  trailing newlines, and how many runs kept them exactly is reported on its own.
  `CHECK_TOOLS_REASONING_EFFORT` adds `reasoning_effort` to every request (`none` turns
  Venice's reasoning off). `CHECK_TOOLS_ONLY=opencode` runs
  only this scenario, e.g. to compare formats for one model with
  `VENICE_TOOL_FORMATS="qwen3-coder=json"` on the proxy. Retries happen inside the
  proxy; the check sends `x-venice-tool-debug: 1`, which makes the proxy report them as
  `venice_tool_attempts` on the response (or on the final chunk when streaming).

## Docker

### Build

```powershell
docker build -t venice-openai-proxy .
```

### Run

```powershell
docker run --rm -p 3456:3456 `
  -e VENICE_EMAIL="$env:VENICE_EMAIL" `
  -e VENICE_PASSWORD="$env:VENICE_PASSWORD" `
  -v "${PWD}\\.venice-web-session.json:/data/.venice-web-session.json" `
  venice-openai-proxy
```

Container behavior at startup:

- tries to restore `/data/.venice-web-session.json`
- if needed, logs in using the browserless `wreq-js` Clerk flow with `VENICE_EMAIL` and `VENICE_PASSWORD`
- persists the refreshed session
- starts the proxy and keeps it running

The Docker image defaults to:

- `HOST=0.0.0.0`
- `PORT=3456`
- `VENICE_SESSION_FILE=/data/.venice-web-session.json`

## Docker Compose

There is a ready-to-use example in `docker-compose.example.yml`.

Start it with:

```powershell
docker compose -f .\docker-compose.example.yml up --build
```

Example service:

```yaml
services:
  venice-openai-proxy:
    build: .
    container_name: venice-openai-proxy
    ports:
      - "3456:3456"
    environment:
      VENICE_EMAIL: ${VENICE_EMAIL}
      VENICE_PASSWORD: ${VENICE_PASSWORD}
      VENICE_SESSION_FILE: /data/.venice-web-session.json
    volumes:
      - ./.venice-web-session.json:/data/.venice-web-session.json
    restart: unless-stopped
```

## Logging

The proxy logs:

- incoming request time
- origin
- request body length
- response status
- selected model
- `content_chars`
- `reasoning_chars`
- `tools` and `tool_calls` counts for requests that used tool emulation, plus `tool_attempts=2` when a call was retried (the translate line also shows `tools`, `tool_choice` and `tool_format`)
- total request duration
- stream duration for streaming completions

## Notes and limitations

- This is not the official Venice API.
- The proxy relies on Venice web auth behavior and may need adjustment if Venice changes its web flow.
- Fresh login is browserless, but it depends on `wreq-js` Chrome impersonation because Clerk currently rejects plain Node/curl HTTP fingerprints with 429s.
- Clerk JWTs are short-lived; the session file is important because it persists cookies needed for restore.
- The proxy does not perform interactive login during requests.
- For container startup, login/restore happens once before the server starts.

## Troubleshooting

### No valid session found

Run:

```powershell
node .\venice-login.mjs
```

Or make sure the container has:

- `VENICE_EMAIL`
- `VENICE_PASSWORD`
- a writable mounted session path

### `/v1/models` returns auth errors

Usually this means the session file is stale or missing. Recreate it with `venice-login.mjs` locally, or restart the container with valid credentials so it can refresh the session on startup.

### Streaming feels buffered

The current `stream: true` path is implemented as incremental streaming from the Venice response stream. If a client still looks buffered, the next thing to check is the client itself, reverse proxies in front of this service, or buffering in Docker/network middleware.
