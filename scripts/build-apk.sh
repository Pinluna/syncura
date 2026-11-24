#!/usr/bin/env bash
# Build an Android APK pointed at the public server, named for its version.
#
#   ./scripts/build-apk.sh https://syncura.example.com '?k=<access key>'
#
# With no second argument the invite code is left out and the phone types the
# server address into Settings itself. The first build downloads Gradle.
#
# Gradle 8 cannot read class files newer than Java 21, and this project compiles
# against API 36. Both are picked automatically when they are installed.
set -euo pipefail

BASE="${1:?usage: build-apk.sh <public base url> [?k=<access key>]}"
ACCESS="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$HERE/package.json').version")"
OUT="$HERE/Syncura-v${VERSION}.apk"

cd "$HERE"

if [ -z "${JAVA_HOME:-}" ] || [ "$(java -version 2>&1 | head -1 | sed 's/.*version "\([0-9]*\).*/\1/')" -gt 21 ]; then
  JDK="$(ls -d "$HOME"/.local/share/mise/installs/java/temurin-21* 2>/dev/null | head -1 || true)"
  if [ -n "$JDK" ]; then
    export JAVA_HOME="$JDK"
    echo "==> Using JDK 21 at $JDK"
  else
    echo "==> No JDK 21 found. Install one, or Gradle will fail on this Java." >&2
  fi
fi

if [ ! -f android/local.properties ]; then
  for sdk in "$HOME/Android/Sdk" "$HOME/android-sdk"; do
    if [ -d "$sdk/platforms/android-36" ]; then
      echo "sdk.dir=$sdk" > android/local.properties
      echo "==> Using the Android SDK at $sdk"
      break
    fi
  done
fi

echo "==> Building Syncura v${VERSION} for ${BASE}"
VITE_NATIVE_API_BASE="$BASE" VITE_ACCESS_KEY="${ACCESS#?k=}" npm run build
# Gradle alone will not refresh the bundled web app, it only packages whatever
# Capacitor last copied. Without this the APK keeps the previous server address.
npx --no-install cap copy android
( cd android && ./gradlew --no-daemon assembleDebug )

cp android/app/build/outputs/apk/debug/app-debug.apk "$OUT"
# Vite wipes dist on every build, so the download has to be refreshed from the
# APK that was just verified. A later bare `npm run build` (npm test's pretest,
# an editor task) still deletes it -- so keep the canonical copy outside dist
# and let the served path fall back to it, rather than trusting dist/ to hold
# the only artifact.
cp "$OUT" dist/syncura.apk
echo "==> $OUT"
echo
echo "Install with:  adb install -r $OUT"

