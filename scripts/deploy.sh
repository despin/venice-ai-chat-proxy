#!/usr/bin/env bash
# Builds and restarts the proxy, stamping the current commit into the image so
# GET /support/info can report which build is running.
#
#   ./scripts/deploy.sh                          # uses docker-compose.yml
#   ./scripts/deploy.sh docker-compose.yml.mine  # uses your own compose file
#
# Compose reads .env from the project directory even under sudo, which shell
# environment variables do not survive, so the commit is written there.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

compose_file="${1:-docker-compose.yml}"
if [ ! -f "$compose_file" ]; then
  echo "compose file not found: $compose_file" >&2
  exit 1
fi

commit="$(git rev-parse HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"

# Preserve any unrelated keys already in .env; only refresh the build stamps.
if [ -f .env ]; then
  grep -v -E '^VENICE_BUILD_(COMMIT|BRANCH)=' .env > .env.tmp || true
else
  : > .env.tmp
fi
printf 'VENICE_BUILD_COMMIT=%s\nVENICE_BUILD_BRANCH=%s\n' "$commit" "$branch" >> .env.tmp
mv .env.tmp .env

echo "Deploying ${branch} @ ${commit:0:7} using ${compose_file}"
sudo docker compose -f "$compose_file" up -d --force-recreate --build

echo "Waiting for the proxy to answer..."
for _ in $(seq 1 30); do
  if curl -fsS -m 5 http://127.0.0.1:3456/support/info > /dev/null 2>&1; then
    curl -fsS -m 5 http://127.0.0.1:3456/support/info
    echo
    exit 0
  fi
  sleep 2
done

echo "Proxy did not answer /support/info in time; check: sudo docker compose -f ${compose_file} logs --tail 50" >&2
exit 1
