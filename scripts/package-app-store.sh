#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_STORE_SOURCE="$ROOT_DIR/app-store/KanTrack"

APP_SIGN_IDENTITY="${APP_STORE_APP_SIGN_IDENTITY:-Apple Distribution: Christopher Cardenas (9686TQV2VP)}"
INSTALLER_SIGN_IDENTITY="${APP_STORE_INSTALLER_SIGN_IDENTITY:-3rd Party Mac Developer Installer: Christopher Cardenas (9686TQV2VP)}"
PROFILE_PATH="${APP_STORE_PROFILE_PATH:-$HOME/Downloads/KanTrack_macOS_App_Store_Profile.provisionprofile}"
SKIP_PREPARE="${APP_STORE_SKIP_PREPARE:-0}"

if [[ "$SKIP_PREPARE" != "1" ]]; then
  echo "Regenerating App Store source..."
  (cd "$ROOT_DIR" && npm run prepare:app-store)
fi

VERSION="$(node -p "require('$APP_STORE_SOURCE/package.json').version")"
APP_PATH="$APP_STORE_SOURCE/src-tauri/target/release/bundle/macos/KanTrack.app"
ENTITLEMENTS_PATH="$APP_STORE_SOURCE/src-tauri/Entitlements.plist"
PKG_PATH="$ROOT_DIR/app-store/KanTrack_${VERSION}_AppStore.pkg"

echo "Project root: $ROOT_DIR"
echo "App Store source: $APP_STORE_SOURCE"
echo "Version: $VERSION"

if [[ ! -d "$APP_STORE_SOURCE" ]]; then
  echo "Missing App Store source folder: $APP_STORE_SOURCE"
  exit 1
fi

if [[ ! -f "$PROFILE_PATH" ]]; then
  echo "Missing provisioning profile: $PROFILE_PATH"
  exit 1
fi

if [[ ! -f "$ENTITLEMENTS_PATH" ]]; then
  echo "Missing entitlements file: $ENTITLEMENTS_PATH"
  exit 1
fi

echo "Checking Apple Distribution identity..."
security find-identity -v -p codesigning | grep -q "$APP_SIGN_IDENTITY"

echo "Checking installer certificate..."
security find-certificate -a -c "$INSTALLER_SIGN_IDENTITY" -Z >/dev/null

cd "$APP_STORE_SOURCE"

if [[ ! -d node_modules ]]; then
  echo "Installing App Store source dependencies..."
  npm ci
fi

echo "Cleaning previous bundle output..."
rm -rf src-tauri/target/release/bundle

echo "Building macOS .app only..."
npm run tauri -- build --bundles app

if [[ ! -d "$APP_PATH" ]]; then
  echo "Built app not found at: $APP_PATH"
  exit 1
fi

echo "Embedding provisioning profile..."
cp "$PROFILE_PATH" "$APP_PATH/Contents/embedded.provisionprofile"

echo "Removing quarantine metadata..."
xattr -cr "$APP_PATH"

echo "Signing app with Apple Distribution identity..."
codesign --force --options runtime \
  --entitlements "$ENTITLEMENTS_PATH" \
  --sign "$APP_SIGN_IDENTITY" \
  "$APP_PATH"

echo "Verifying app signature..."
codesign --verify --strict --verbose=2 "$APP_PATH"

echo "Verifying embedded entitlements..."
codesign -d --entitlements - "$APP_PATH"

if ! codesign -d --entitlements - "$APP_PATH" 2>/dev/null | grep -q "com.apple.security.app-sandbox"; then
  echo "ERROR: Signed app is missing com.apple.security.app-sandbox."
  exit 1
fi

if ! codesign -d --entitlements - "$APP_PATH" 2>/dev/null | grep -q "com.apple.application-identifier"; then
  echo "ERROR: Signed app is missing com.apple.application-identifier."
  echo "Fix src-tauri/Entitlements.plist before uploading."
  exit 1
fi

echo "Creating signed pkg..."
rm -f "$PKG_PATH"

productbuild \
  --component "$APP_PATH" /Applications \
  --sign "$INSTALLER_SIGN_IDENTITY" \
  "$PKG_PATH"

echo "Verifying pkg signature..."
pkgutil --check-signature "$PKG_PATH"

echo
echo "Done. Upload this file in Transporter:"
echo "$PKG_PATH"
