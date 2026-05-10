#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/src-tauri/target/release/bundle/macos/KanTrack.app"
BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle/dmg"
MACOS_DIR="$ROOT/src-tauri/target/release/bundle/macos"
VERSION="$(node -e "console.log(require('$ROOT/src-tauri/tauri.conf.json').version)")"
TAG="v$VERSION"
NOTARY_ZIP="$BUNDLE_DIR/KanTrack-$VERSION-notary.zip"
FINAL_ZIP="$BUNDLE_DIR/KanTrack-$VERSION-notarized-Apple-Silicon.zip"
FINAL_DMG="$BUNDLE_DIR/KanTrack-$VERSION-notarized-Apple-Silicon.dmg"
DMG_STAGING="$BUNDLE_DIR/dmg-staging"
UPDATER_TAR="$MACOS_DIR/KanTrack.app.tar.gz"
UPDATER_SIG="$MACOS_DIR/KanTrack.app.tar.gz.sig"
LATEST_JSON="$BUNDLE_DIR/latest.json"
RELEASE_DIR="$ROOT/release/$TAG"
RELEASE_BASE_URL="https://github.com/ChrisCrdns/kantrack-releases/releases/download/$TAG"
PROFILE="${NOTARY_PROFILE:-KanTrack}"
UPDATER_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/kantrack-updater.key}"

export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

cd "$ROOT"

node <<NODE
const fs = require('fs');
const pkg = require('$ROOT/package.json');
const tauri = require('$ROOT/src-tauri/tauri.conf.json');
const cargoToml = fs.readFileSync('$ROOT/src-tauri/Cargo.toml', 'utf8');
const cargoVersion = cargoToml.match(/^version\\s*=\\s*"([^"]+)"/m)?.[1];
const lock = fs.readFileSync('$ROOT/src-tauri/Cargo.lock', 'utf8');
const lockVersion = lock.match(/name = "kantrack"\\nversion = "([^"]+)"/)?.[1];
const versions = { 'package.json': pkg.version, 'tauri.conf.json': tauri.version, 'Cargo.toml': cargoVersion, 'Cargo.lock': lockVersion };
const bad = Object.entries(versions).filter(([, v]) => v !== '$VERSION');
if (bad.length) {
  console.error('Version mismatch. Refusing to package:');
  for (const [file, version] of Object.entries(versions)) console.error(`- ${file}: ${version}`);
  process.exit(1);
}
NODE

echo "Finding Developer ID Application certificate..."
IDENTITY="$(security find-identity -v -p codesigning | awk -F '"' '/Developer ID Application/ { print $2; exit }')"

if [[ -z "$IDENTITY" ]]; then
  echo "No Developer ID Application certificate found in your keychain."
  echo "Install the certificate, then run this script again."
  exit 1
fi

echo "Using signing identity: $IDENTITY"

if [[ ! -f "$UPDATER_KEY_PATH" ]]; then
  echo "No Tauri updater signing key found at:"
  echo "$UPDATER_KEY_PATH"
  echo "Generate it with: npm run tauri signer generate -- -w ~/.tauri/kantrack-updater.key"
  exit 1
fi

echo "Building KanTrack.app..."
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY_PATH")"
npm run tauri -- build --bundles app

echo "Removing quarantine metadata..."
xattr -cr "$APP"

echo "Signing app..."
codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

mkdir -p "$BUNDLE_DIR"
rm -rf "$DMG_STAGING"
rm -f "$NOTARY_ZIP" "$FINAL_ZIP" "$FINAL_DMG" "$UPDATER_TAR" "$UPDATER_SIG" "$LATEST_JSON"

echo "Creating notarization zip..."
ditto -c -k --keepParent "$APP" "$NOTARY_ZIP"

echo "Submitting to Apple notarization..."
xcrun notarytool submit "$NOTARY_ZIP" --keychain-profile "$PROFILE" --wait

echo "Stapling notarization ticket to app..."
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

echo "Creating final distributable zip..."
ditto -c -k --keepParent "$APP" "$FINAL_ZIP"

echo "Creating final distributable DMG..."
mkdir -p "$DMG_STAGING"
ditto "$APP" "$DMG_STAGING/KanTrack.app"
ln -s /Applications "$DMG_STAGING/Applications"
hdiutil create \
  -volname "KanTrack $VERSION" \
  -srcfolder "$DMG_STAGING" \
  -format UDZO \
  -ov \
  "$FINAL_DMG"

echo "Signing DMG..."
codesign --force --timestamp --sign "$IDENTITY" "$FINAL_DMG"
codesign --verify --verbose=2 "$FINAL_DMG"

echo "Submitting DMG to Apple notarization..."
xcrun notarytool submit "$FINAL_DMG" --keychain-profile "$PROFILE" --wait

echo "Stapling notarization ticket to DMG..."
xcrun stapler staple "$FINAL_DMG"
xcrun stapler validate "$FINAL_DMG"
hdiutil verify "$FINAL_DMG"
rm -rf "$DMG_STAGING"

echo "Creating updater bundle..."
tar --disable-copyfile --no-xattrs -czf "$UPDATER_TAR" -C "$MACOS_DIR" "KanTrack.app"

if tar -tzf "$UPDATER_TAR" | grep -q '/\._\|^\._'; then
  echo "Updater bundle contains macOS AppleDouble metadata files."
  exit 1
fi

echo "Signing updater bundle..."
SIGNATURE_OUTPUT="$(mktemp)"
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  ./node_modules/.bin/tauri signer sign -p "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" "$UPDATER_TAR" > "$SIGNATURE_OUTPUT" 2>&1
else
  ./node_modules/.bin/tauri signer sign "$UPDATER_TAR" > "$SIGNATURE_OUTPUT" 2>&1
fi
awk '/^[A-Za-z0-9+\/=]+$/ { line=$0 } END { if (line) print line; else exit 1 }' "$SIGNATURE_OUTPUT" > "$UPDATER_SIG"
rm -f "$SIGNATURE_OUTPUT"

if grep -q "Make sure" "$UPDATER_SIG"; then
  echo "Updater signature was not extracted correctly."
  exit 1
fi

echo "Writing latest.json..."
node <<NODE
const fs = require('fs');
const latest = {
  version: "$VERSION",
  notes: "KanTrack $VERSION",
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      signature: fs.readFileSync("$UPDATER_SIG", "utf8").trim(),
      url: "$RELEASE_BASE_URL/KanTrack.app.tar.gz"
    }
  }
};
fs.writeFileSync("$LATEST_JSON", JSON.stringify(latest, null, 2) + "\\n");
NODE

echo "Validating updater metadata..."
node <<NODE
const fs = require('fs');
const latestPath = "$LATEST_JSON";
const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
const expectedUrl = "$RELEASE_BASE_URL/KanTrack.app.tar.gz";
const actualUrl = latest.platforms?.["darwin-aarch64"]?.url;
if (latest.version !== "$VERSION") {
  console.error(`latest.json version mismatch: expected $VERSION, got ${latest.version}`);
  process.exit(1);
}
if (actualUrl !== expectedUrl) {
  console.error('latest.json updater URL mismatch.');
  console.error(`Expected: ${expectedUrl}`);
  console.error(`Actual:   ${actualUrl}`);
  process.exit(1);
}
if (!actualUrl.includes('/download/$TAG/')) {
  console.error('latest.json does not point at the exact release tag $TAG.');
  process.exit(1);
}
NODE

echo "Collecting GitHub release files..."
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
cp "$FINAL_ZIP" "$RELEASE_DIR/"
cp "$FINAL_DMG" "$RELEASE_DIR/"
cp "$UPDATER_TAR" "$RELEASE_DIR/"
cp "$UPDATER_SIG" "$RELEASE_DIR/"
cp "$LATEST_JSON" "$RELEASE_DIR/"

cat > "$RELEASE_DIR/README-upload-checklist.txt" <<EOF
KanTrack $VERSION GitHub release upload checklist

Release tag:
$TAG

Upload these 5 files to the GitHub release:
1. KanTrack-$VERSION-notarized-Apple-Silicon.zip
2. KanTrack-$VERSION-notarized-Apple-Silicon.dmg
3. KanTrack.app.tar.gz
4. KanTrack.app.tar.gz.sig
5. latest.json

GitHub release page:
https://github.com/ChrisCrdns/kantrack-releases/releases/new?tag=$TAG

Important:
- The release tag must be exactly $TAG.
- latest.json points to:
  $RELEASE_BASE_URL/KanTrack.app.tar.gz
- The DMG is for manual installs. Auto-update still uses KanTrack.app.tar.gz.
EOF

echo
echo "Done:"
echo "$FINAL_ZIP"
echo "$FINAL_DMG"
echo "$UPDATER_TAR"
echo "$UPDATER_SIG"
echo "$LATEST_JSON"
echo
echo "GitHub release folder:"
echo "$RELEASE_DIR"
echo
echo "============================================"
echo "  IMPORTANT: Create the GitHub release with"
echo "  tag exactly: $TAG  (lowercase v)"
echo "  URL: https://github.com/ChrisCrdns/kantrack-releases/releases/new?tag=$TAG"
echo "============================================"
