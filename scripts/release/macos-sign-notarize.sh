#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   APP_PATH=./src-tauri/target/release/bundle/macos/Friction.app \
#   TEAM_ID=ABCDE12345 \
#   APPLE_ID=you@example.com \
#   APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
#   ./scripts/release/macos-sign-notarize.sh

: "${APP_PATH:?APP_PATH is required}"
: "${TEAM_ID:?TEAM_ID is required}"
: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_APP_PASSWORD:?APPLE_APP_PASSWORD is required}"

if [[ ! -d "${APP_PATH}" ]]; then
  echo "App bundle not found: ${APP_PATH}"
  exit 1
fi

ZIP_PATH="${APP_PATH%.*}.zip"
SIGNED_ZIP="${APP_PATH%.*}-signed.zip"

echo "Codesigning app..."
codesign --force --deep --options runtime --sign "${TEAM_ID}" "${APP_PATH}"

echo "Creating zip for notarization..."
ditto -c -k --keepParent "${APP_PATH}" "${ZIP_PATH}"

echo "Submitting notarization..."
xcrun notarytool submit "${ZIP_PATH}" \
  --apple-id "${APPLE_ID}" \
  --password "${APPLE_APP_PASSWORD}" \
  --team-id "${TEAM_ID}" \
  --wait

echo "Stapling ticket..."
xcrun stapler staple "${APP_PATH}"

echo "Producing signed archive..."
ditto -c -k --keepParent "${APP_PATH}" "${SIGNED_ZIP}"
echo "Done: ${SIGNED_ZIP}"
