#!/usr/bin/env bash
# Runs the on-device boot regression test.
#
# This one cannot simply talk to a running server. It loads the *built* app in a
# simulated Capacitor WebView, so the server address is compiled into the
# bundle: a plain build points the app at the real invite-gated server, the
# sign-up never completes, and the test then fails for reasons that have nothing
# to do with what it is checking. Worse, it is one hiccup away from posting
# throwaway signups at the live database.
#
# So: build aimed at the throwaway test server, run the test, then build again
# with no override so dist/ is never left pointing at the test server.
#
# Keep TEST_PORT in step with scripts/serve.sh and scripts/test-env.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

TEST_PORT="${SYNCURA_TEST_PORT:-5003}"
TEST_API="http://localhost:${TEST_PORT}"

# The test server runs without SYNCURA_ACCESS_KEY, so no gate to satisfy here.
# Leaving the previously baked-in key in would be harmless but misleading.
echo "==> Building the app against the test server on $TEST_API"
VITE_NATIVE_API_BASE="$TEST_API" VITE_ACCESS_KEY= npx vite build

echo "==> Running the native boot test"
TZ="${TZ:-UTC}" API="$TEST_API" npx tsx scripts/native-boot-test.ts

echo "==> Rebuilding without the override so dist/ points at the real server"
npm run build
