# Venice OpenAI Proxy

This project exposes the Venice web app as an OpenAI-compatible API so tools like Open WebUI can use your Venice web session without going through the official Venice API route.

It currently provides:

- `GET /v1/models`
- `POST /v1/chat/completions`
- streaming chat completions
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

If Open WebUI runs in Docker and the proxy runs on the host, use:

- `http://host.docker.internal:3456/v1`

If both run in the same Docker Compose project, use:

- `http://venice-openai-proxy:3456/v1`

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
