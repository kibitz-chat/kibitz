#!/usr/bin/env bash
#
# prerelease-local.sh — stand up a FULL local mirror of kibitz.chat (the real Cloudflare
# Pages stack: prerendered dist/ + functions/api/* edge functions) and pre-release-check it.
#
# It does, in order:
#   1. ensure .dev.vars exists (so /api/signal points at the live broker, like prod)
#   2. run the test suite           (skip: --no-test)
#   3. fresh production build        (skip: --no-build / --smoke-only)
#   4. launch `wrangler pages dev dist` in the background, wait until it's serving
#   5. smoke-test every endpoint the deployed site exposes; fail loudly on any miss
#   6. leave it running and print the URLs + how to stop it
#
# Usage:
#   scripts/prerelease-local.sh                # full: test → build → serve → smoke
#   scripts/prerelease-local.sh --no-test      # skip the vitest gate (faster)
#   scripts/prerelease-local.sh --smoke-only   # don't rebuild; just (re)serve + smoke existing dist/
#   scripts/prerelease-local.sh --port 9000    # use a different port (default 8788)
#   scripts/prerelease-local.sh --stop         # stop a mirror this script started
#
# Exit code is 0 only when the build/tests pass AND every smoke check passes — so it's safe
# to gate a manual release on `scripts/prerelease-local.sh && echo OK to ship`.

set -euo pipefail

# --- locate the repo root (this script lives in <root>/scripts) ---------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT=8788
DO_TEST=1
DO_BUILD=1
STOP_ONLY=0
PIDFILE="/tmp/kibitz-mirror.pid"
LOGFILE="/tmp/kibitz-mirror.log"

# --- args ---------------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --no-test)    DO_TEST=0 ;;
    --no-build)   DO_BUILD=0 ;;
    --smoke-only) DO_BUILD=0 ;;
    --port)       PORT="${2:?--port needs a value}"; shift ;;
    --stop)       STOP_ONLY=1 ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# --- stop a previously-started mirror ------------------------------------------------------
stop_mirror() {
  if [ -f "$PIDFILE" ]; then
    local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      # wrangler spawns a workerd child; kill the whole process group.
      kill "$pid" 2>/dev/null || true
      pkill -P "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  # belt-and-suspenders: anything still bound to the port
  if command -v fuser >/dev/null 2>&1; then fuser -k "${PORT}/tcp" 2>/dev/null || true; fi
}

if [ "$STOP_ONLY" = 1 ]; then
  bold "Stopping local mirror on :$PORT"
  stop_mirror
  ok "stopped"
  exit 0
fi

# --- 1. .dev.vars (local edge-function config, gitignored) --------------------------------
if [ ! -f .dev.vars ]; then
  bold "Creating .dev.vars (gitignored) — points /api/signal at the live broker, like prod"
  cat > .dev.vars <<'EOF'
# Local full-mirror config for `wrangler pages dev` — NOT committed.
SIGNAL_HOST=signal.kibitz.chat
# Add your Cloudflare Realtime TURN secrets to relay cross-network locally; without them
# /api/turn returns configured:false and calls are STUN-only (fine on a permissive net).
# TURN_KEY_ID=
# TURN_KEY_API_TOKEN=
EOF
  ok "wrote .dev.vars"
fi

# --- 2. test gate -------------------------------------------------------------------------
if [ "$DO_TEST" = 1 ]; then
  bold "Running tests (vitest)…"
  if npx vitest run >/tmp/kibitz-prerelease-test.log 2>&1; then
    ok "$(grep -Eo 'Tests +[0-9]+ passed' /tmp/kibitz-prerelease-test.log | tail -1 || echo 'tests passed')"
  else
    bad "tests FAILED — see /tmp/kibitz-prerelease-test.log"
    tail -25 /tmp/kibitz-prerelease-test.log
    exit 1
  fi
fi

# --- 3. build -----------------------------------------------------------------------------
if [ "$DO_BUILD" = 1 ]; then
  bold "Building (prerender + widget + SPA + llms)…"
  if npm run build >/tmp/kibitz-prerelease-build.log 2>&1; then
    ok "build succeeded → dist/"
  else
    bad "build FAILED — see /tmp/kibitz-prerelease-build.log"
    tail -25 /tmp/kibitz-prerelease-build.log
    exit 1
  fi
fi
if [ ! -f dist/index.html ]; then
  bad "dist/index.html missing — run without --smoke-only at least once"
  exit 1
fi

# --- 4. serve the real Pages stack (workerd) ----------------------------------------------
bold "Starting the Cloudflare mirror on :$PORT (wrangler pages dev)…"
stop_mirror   # clear any prior instance on this port first
nohup npx -y wrangler pages dev dist --port "$PORT" --ip 0.0.0.0 \
  --compatibility-date 2024-09-23 --kv OTP_KV > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"

# wait until it's actually serving (first run also downloads wrangler+workerd → be patient)
deadline=$(( SECONDS + 180 ))
until curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; do
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    bad "wrangler exited before serving — see $LOGFILE"; tail -25 "$LOGFILE"; exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    bad "timed out waiting for :$PORT — see $LOGFILE"; tail -25 "$LOGFILE"; exit 1
  fi
  sleep 2
done
ok "serving at http://localhost:${PORT}/"

# --- 5. smoke tests (every endpoint the deployed site exposes) ----------------------------
bold "Smoke-testing endpoints…"
FAILED=0
base="http://127.0.0.1:${PORT}"

# code <url> <accepted-codes-regex> <label>
code() {
  local got; got="$(curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000)"
  if printf '%s' "$got" | grep -qE "$2"; then ok "$3 ($got)"; else bad "$3 (got $got, want $2)"; FAILED=1; fi
}
# body <url> <grep-pattern> <label>
# Capture first, then grep a here-string — NOT `curl | grep -q`: grep -q exits on the first
# match and closes the pipe, which SIGPIPEs curl, and `set -o pipefail` would then mark the
# whole pipeline failed (only bites on large bodies like widget.js that aren't fully buffered).
body() {
  local out; out="$(curl -fsS "$1" 2>/dev/null || true)"
  if grep -qE "$2" <<<"$out"; then ok "$3"; else bad "$3 (pattern '$2' not found)"; FAILED=1; fi
}

code "$base/"                    '200'     "landing /"
body "$base/"                    'Kibitz'  "landing is prerendered (contains 'Kibitz')"
code "$base/widget.js"           '200'     "embeddable widget.js"
body "$base/widget.js"           '.'       "widget.js has a body"
code "$base/llms.txt"            '200'     "llms.txt"
code "$base/llms-full.txt"       '200'     "llms-full.txt"
code "$base/manual.md"           '200'     "manual.md"
code "$base/docs"                '200|30[18]' "/docs page"
code "$base/privacy"             '200|30[18]' "/privacy page"
code "$base/terms"               '200|30[18]' "/terms page"
code "$base/security"            '200|30[18]' "/security page"
code "$base/?g=invite&gk=AAA"    '200'     "SPA gate deep-link serves the app shell"
body "$base/api/signal"          'signal\.kibitz\.chat' "/api/signal edge fn → live broker"
body "$base/api/turn"            'configured' "/api/turn edge fn responds (configured flag)"

echo
HOSTIP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ "$FAILED" = 0 ]; then
  bold "PRE-RELEASE OK ✓  — full mirror is live and all checks passed"
  echo "  Open:    http://localhost:${PORT}/"
  [ -n "${HOSTIP:-}" ] && echo "  Windows: http://${HOSTIP}:${PORT}/   (if localhost forwarding is off)"
  echo "  Logs:    $LOGFILE"
  echo "  Stop:    scripts/prerelease-local.sh --stop"
  echo
  echo "  Note: TURN is off locally (STUN-only) unless you add TURN secrets to .dev.vars;"
  echo "        signaling uses the REAL signal.kibitz.chat, so two browsers actually connect."
  echo "        After a rebuild, HARD-REFRESH the tab (Ctrl-Shift-R) — the landing has a SW cache."
  exit 0
else
  bad "PRE-RELEASE FAILED — some endpoints did not respond as expected (see above)"
  echo "  The mirror is still running for debugging: $LOGFILE  (stop: scripts/prerelease-local.sh --stop)"
  exit 1
fi
