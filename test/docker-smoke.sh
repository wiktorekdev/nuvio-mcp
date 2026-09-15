#!/usr/bin/env bash
# Docker end-to-end smoke test: builds the image, runs it as non-root with a data
# volume, verifies the HTTP endpoint and that session/snapshots/audit are writable.
set -euo pipefail

IMAGE="${1:-nuvio-mcp:smoke}"
NAME="nuvio-mcp-smoke-$$"
PORT="${NUVIO_SMOKE_PORT:-18333}"
TOKEN="smoke-token-$$"
VOLUME="nuvio-smoke-data-$$"
BASE="http://127.0.0.1:${PORT}"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> building $IMAGE"
docker build -t "$IMAGE" . >/dev/null

echo "==> running container"
docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:3333" \
  -e "NUVIO_HTTP_TOKEN=${TOKEN}" \
  -e "NUVIO_HTTP_ALLOWED_HOSTS=127.0.0.1" \
  -e "NUVIO_EMAIL=${NUVIO_EMAIL:-smoke@example.com}" \
  -e "NUVIO_PASSWORD=${NUVIO_PASSWORD:-smoke-password}" \
  -e "NUVIO_BACKEND_URL=${NUVIO_BACKEND_URL:-http://127.0.0.1:1}" \
  -v "${VOLUME}:/data" \
  "$IMAGE" >/dev/null

echo "==> waiting for health"
for _ in $(seq 1 40); do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "${BASE}/health" | grep -q '"status":"ok"'

echo "==> container runs as non-root"
test "$(docker exec "$NAME" id -un)" = "node"

echo "==> unauthenticated request is rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
test "$code" = "401"

echo "==> data volume is writable by the container user"
docker exec "$NAME" sh -c 'test -w /data'
docker exec "$NAME" sh -c 'touch /data/.write-test && rm /data/.write-test'

echo "docker smoke test passed"
