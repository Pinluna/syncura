#!/usr/bin/env bash
# Starts the Syncura test API detached from the calling shell so it survives the
# tool's process-group cleanup. Usage: scripts/serve.sh [--fresh]
#
# This starts the *test* server. It deliberately does not share a port or a
# data file with the real service in syncura.service:
#
#   * A different port (5003, not 5002) so it cannot collide with the live API.
#   * A different data file (data/syncura.test.json, not data/syncura.json) so
#     `--fresh` can never rotate the real database away.
#
# Both of those used to be shared, which meant a test run replaced every real
# account with throwaway ones. The phone's stored token then came back 401, the
# app cleared it, and the user was dropped at the welcome screen on next launch.
# Keep TEST_PORT in step with scripts/test-env.ts, which the test scripts read.
set -euo pipefail
cd "$(dirname "$0")/.."

TEST_PORT="${SYNCURA_TEST_PORT:-5003}"
TEST_DATA_FILE="${SYNCURA_TEST_DATA_FILE:-data/syncura.test.json}"

# The whole point of the split is that these never coincide. Refuse to start
# rather than let a mistyped override put the disposable test server back on the
# live database, which is the failure this script exists to prevent.
if [ "$(cd "$(dirname "$TEST_DATA_FILE")" && pwd)/$(basename "$TEST_DATA_FILE")" = "$PWD/data/syncura.json" ]; then
  echo "refusing to run the test server on the live database: $TEST_DATA_FILE" >&2
  exit 1
fi

# A development or test server: the request caps exist to protect a public
# deployment, and here they would only get in the way of the suite.
export SYNCURA_RATE_REGISTER=0
export SYNCURA_RATE_CONNECT=0
export SYNCURA_RATE_GENERAL=0

# The test server never sees the live database, so there is no encrypted file
# here to preserve: SYNCURA_DATA_KEY is deliberately left unset.
unset SYNCURA_DATA_KEY
export PORT="$TEST_PORT"
export SYNCURA_DATA_FILE="$TEST_DATA_FILE"

# A recognisable relay so the API tests can prove the configured ICE list is
# what reaches paired clients.
export SYNCURA_ICE_SERVERS='[{"urls":"stun:stun.test.invalid:3478"}]'

LOG="${SYNCURA_TEST_LOG:-${TMPDIR:-/tmp}/syncura-server.log}"
PIDFILE="${SYNCURA_TEST_PIDFILE:-${TMPDIR:-/tmp}/syncura-server.pid}"
mkdir -p "$(dirname "$LOG")" "$(dirname "$TEST_DATA_FILE")"

if [ "${1:-}" = "--fresh" ]; then
  # Only ever the test database. The live one is not touched by this script.
  # -rf because the media store beside it is a directory, and a plain rm -f
  # fails on that under `set -e` and takes the whole startup down with it.
  rm -rf "$TEST_DATA_FILE" "${TEST_DATA_FILE}.media"
fi

# The server outlives the suite, so it has to be reaped by the next run or it
# keeps the test port busy and the next run fails to start. The pid is matched
# against its command line first, because pids get reused, and the whole group
# is signalled because tsx forks a child that would otherwise keep the port.
#
# Only the pid this script recorded is signalled. Matching on the command line
# alone would also match the real service, which runs the same file.
reap() {
  local pid="$1" pgid
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 0
  ps -p "$pid" -o args= 2>/dev/null | grep -q 'tsx server/index.ts' || return 0
  pgid="$(ps -o pgid= "$pid" 2>/dev/null | tr -d ' ')"
  kill -- "-$pgid" 2>/dev/null || kill "$pid" 2>/dev/null || true
}
[ -f "$PIDFILE" ] && { reap "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; }

setsid nohup npx tsx server/index.ts > "$LOG" 2>&1 < /dev/null &
echo "$!" > "$PIDFILE"
disown || true

for _ in $(seq 1 40); do
  if curl -sf -m 2 "http://localhost:$TEST_PORT/api/health" > /dev/null 2>&1; then
    echo "syncura test api ready on http://localhost:$TEST_PORT (data: $TEST_DATA_FILE)"
    exit 0
  fi
  sleep 0.5
done

echo "server failed to start; log follows" >&2
tail -20 "$LOG" >&2
exit 1

