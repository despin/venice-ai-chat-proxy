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
- Python 3 with `venv` support
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
node .\venice-login.mjs
```

This performs a fresh Clerk credential login without Chrome. It uses Python `curl_cffi` so the HTTP/TLS stack looks like Chrome to Clerk, validates the Venice web session, and writes `.venice-web-session.json` by default.

If `curl_cffi` is not already available, `venice-login.mjs` creates `.venice-login-venv/` and installs it there. To manage the dependency yourself:

```powershell
python3 -m pip install -r requirements.txt
```

Optional modes:

```powershell
node .\venice-login.mjs --restore
node .\venice-login.mjs --restore-only
node .\venice-login.mjs --direct
```

`--restore-only` refreshes from the saved session/cookies and never falls back to credential login. `--restore` keeps the older restore/direct fallback behavior for debugging. `--direct` uses the plain Node fetch implementation, which is useful for confirming Clerk bot/rate rejection but is not the normal login path.

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
- if needed, logs in using the browserless `curl_cffi` Clerk flow with `VENICE_EMAIL` and `VENICE_PASSWORD`
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
- Fresh login is browserless, but it depends on `curl_cffi` Chrome impersonation because Clerk currently rejects plain Node/curl HTTP fingerprints with 429s.
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
