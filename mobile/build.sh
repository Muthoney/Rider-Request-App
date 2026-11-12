#!/usr/bin/env bash
# Builds the Rider Requests Android app.
#
#   ./build.sh debug   [APP_URL]   debug APK for internal testing (default APP_URL http://localhost:3000)
#   ./build.sh release [APP_URL]   signed release APK + Play Store bundle (AAB) (default https://ride-request.lookmedia.co.ke)
#
# APP_URL must equal the server's APP_ORIGIN. Release builds accept HTTPS only.
# Optional: put google-services.json (Firebase) next to this script to enable push notifications.
# Outputs: mobile/dist/rider-requests-<version>[-debug].apk and rider-requests-<version>.aab
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-debug}"
VERSION_NAME="${VERSION_NAME:-2.0.0}"
VERSION_CODE="${VERSION_CODE:-200}"
case "$MODE" in
  debug) APP_URL="${2:-${APP_URL:-http://localhost:3000}}" ;;
  release) APP_URL="${2:-${APP_URL:-https://ride-request.lookmedia.co.ke}}" ;;
  *) echo "Usage: $0 debug|release [APP_URL]" >&2; exit 1 ;;
esac
APP_URL="${APP_URL%/}"
if [ "$MODE" = release ] && [[ "$APP_URL" != https://* ]]; then echo "Release builds must use an https:// APP_URL (got $APP_URL)." >&2; exit 1; fi
if [ "$MODE" = debug ] && [[ "$APP_URL" != https://* && ! "$APP_URL" =~ ^http://(localhost|127\.0\.0\.1|10\.0\.2\.2)(:[0-9]+)?$ ]]; then
  echo "Debug builds use https:// or a local development server (localhost / 10.0.2.2), got $APP_URL" >&2; exit 1
fi

export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
[ -d "$ANDROID_HOME/platforms" ] || { echo "Android SDK not found at $ANDROID_HOME (set ANDROID_HOME)." >&2; exit 1; }
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
[ -d node_modules/@capacitor/android ] || npm install --no-audit --no-fund

# Point the app at the server for this build.
node -e '
  const fs = require("fs"); const [url, mode] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync("capacitor.config.json", "utf8"));
  const u = new URL(url);
  c.server.url = url; c.server.cleartext = u.protocol === "http:"; c.server.allowNavigation = [u.host];
  c.android.webContentsDebuggingEnabled = mode === "debug";
  fs.writeFileSync("capacitor.config.json", JSON.stringify(c, null, 2) + "\n");
' "$APP_URL" "$MODE"
# The bundled fallback pages (offline.html, index.html) send the rider back to the server.
printf 'window.__rrUrl = %s;\n' "\"$APP_URL/\"" > www/app-url.js

# Firebase push only when google-services.json is supplied.
if [ -f google-services.json ]; then
  cp google-services.json android/app/google-services.json
  [ -d node_modules/@capacitor/push-notifications ] || npm install --no-audit --no-fund @capacitor/push-notifications@8.1.3
  echo "Push notifications: on (google-services.json found)"
else
  rm -f android/app/google-services.json
  if [ -d node_modules/@capacitor/push-notifications ]; then npm uninstall --no-audit --no-fund @capacitor/push-notifications >/dev/null; fi
  echo "Push notifications: off (add google-services.json to enable; SMS fallback covers alerts meanwhile)"
fi

npx cap sync android

cd android
GRADLE_ARGS=(-PversionName="$VERSION_NAME" -PversionCode="$VERSION_CODE" --no-daemon --console=plain)
mkdir -p ../dist
BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
if [ "$MODE" = debug ]; then
  ./gradlew "${GRADLE_ARGS[@]}" assembleDebug
  OUT="../dist/rider-requests-$VERSION_NAME-debug.apk"
  cp app/build/outputs/apk/debug/app-debug.apk "$OUT"
else
  [ -f keystore.properties ] || { echo "android/keystore.properties is missing: see mobile/README.md (Signing)." >&2; exit 1; }
  ./gradlew "${GRADLE_ARGS[@]}" assembleRelease bundleRelease
  OUT="../dist/rider-requests-$VERSION_NAME.apk"
  cp app/build/outputs/apk/release/app-release.apk "$OUT"
  cp app/build/outputs/bundle/release/app-release.aab "../dist/rider-requests-$VERSION_NAME.aab"
fi
"$BT/apksigner" verify --print-certs "$OUT" | grep -E "Signer #1 certificate (DN|SHA-256)" || true
echo
echo "Built $(cd .. && pwd)/dist/$(basename "$OUT")  →  $APP_URL"
[ "$MODE" = release ] && echo "      $(cd .. && pwd)/dist/rider-requests-$VERSION_NAME.aab  (upload this one to Google Play)"
sha256sum ../dist/rider-requests-"$VERSION_NAME"* | sed 's#\.\./dist/##'
