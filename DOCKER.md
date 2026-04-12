**Build**

```powershell
docker build -t venice-openai-proxy .
```

**Login Once**

Create the session file on the host if you want to seed an existing session, or let the container do the login at startup.

```powershell
$env:VENICE_EMAIL="you@example.com"
$env:VENICE_PASSWORD="your-password"
$env:VENICE_SESSION_FILE="$PWD\\.venice-web-session.json"
node .\venice-login.mjs
```

**Run Container**

```powershell
docker run --rm -p 3456:3456 `
  -e VENICE_EMAIL="$env:VENICE_EMAIL" `
  -e VENICE_PASSWORD="$env:VENICE_PASSWORD" `
  -v "${PWD}\\.venice-web-session.json:/data/.venice-web-session.json" `
  venice-openai-proxy
```

At container startup it will:

- try to restore the saved session from `/data/.venice-web-session.json`
- fall back to a full Venice login with `VENICE_EMAIL` and `VENICE_PASSWORD` if needed
- keep the proxy running after auth completes

Point Open WebUI at:

- Base URL: `http://host.docker.internal:3456/v1`
- API key: any non-empty value if required by the UI

**Docker Compose Example**

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

There is also a ready-to-use example file at [docker-compose.example.yml](/D:/code/venice-ai-proxy/docker-compose.example.yml).

If Open WebUI is also in Docker Compose, use:

- Base URL: `http://venice-openai-proxy:3456/v1`

**Notes**

- The proxy does not perform interactive login on request. The session file must already exist.
- The proxy still does not log in during incoming requests. Login or restore happens once at container startup.
- Clerk JWTs are short-lived; the persisted cookies inside the session file are what allow restore.
- If the session fully expires, the container startup path will log in again as long as `VENICE_EMAIL` and `VENICE_PASSWORD` are set.
