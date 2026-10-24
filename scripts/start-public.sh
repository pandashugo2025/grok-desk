#!/usr/bin/env bash
# Start GROK DESK locally and open a Cloudflare quick tunnel.
# Writes the public URL to output/public-url.txt
# Paper / simulation only — no keys, no live orders.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8765}"
OUT="$ROOT/output"
LOG="$OUT/public-run.log"
URL_FILE="$OUT/public-url.txt"
PID_FILE="$OUT/public.pids"

mkdir -p "$OUT"
cd "$ROOT"

# Prefer venv python if present
PY=python3
if [[ -x "$ROOT/.venv/bin/python" ]]; then PY="$ROOT/.venv/bin/python"; fi

have_cmd() { command -v "$1" >/dev/null 2>&1; }

if ! have_cmd cloudflared; then
  echo "cloudflared not found."
  echo "Install: brew install cloudflared   # macOS"
  echo "     or: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

# Stop previous public stack if we started it
if [[ -f "$PID_FILE" ]]; then
  while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < "$PID_FILE" || true
  rm -f "$PID_FILE"
fi

# Start desk if port free
if ! curl -sf "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
  echo "Starting run.py on :${PORT} ..."
  nohup "$PY" "$ROOT/run.py" --port "$PORT" >"$OUT/run.log" 2>&1 &
  echo $! >> "$PID_FILE"
  for i in $(seq 1 30); do
    curl -sf "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 && break
    sleep 0.3
  done
else
  echo "Desk already listening on :${PORT}"
fi

echo "Starting cloudflared quick tunnel ..."
: > "$LOG"
nohup cloudflared tunnel --url "http://127.0.0.1:${PORT}" --protocol http2 >"$LOG" 2>&1 &
CF_PID=$!
echo "$CF_PID" >> "$PID_FILE"

URL=""
for i in $(seq 1 40); do
  URL=$(grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  if [[ -n "$URL" ]]; then break; fi
  # bail if cloudflared died
  if ! kill -0 "$CF_PID" 2>/dev/null; then
    echo "cloudflared exited early. See $LOG"
    tail -n 40 "$LOG" || true
    exit 1
  fi
  sleep 0.4
done

if [[ -z "$URL" ]]; then
  echo "Timed out waiting for tunnel URL. See $LOG"
  tail -n 40 "$LOG" || true
  exit 1
fi

echo "$URL" > "$URL_FILE"
echo ""
echo "GROK DESK public URL:"
echo "  $URL"
echo "  (also written to $URL_FILE)"
echo "Local: http://127.0.0.1:${PORT}/?v=mind17"
echo "Hard-refresh after UI edits. Paper / SIM only."
echo ""
echo "Stop: kill \$(cat $PID_FILE)"
