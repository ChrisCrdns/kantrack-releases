#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -e "console.log(require('$ROOT/src-tauri/tauri.conf.json').version)")"
TAG="v$VERSION"
RELEASE_DIR="$ROOT/release/$TAG"
REPO="ChrisCrdns/kantrack-releases"
EXPECTED_URL="https://github.com/$REPO/releases/download/$TAG/KanTrack.app.tar.gz"

cd "$ROOT"

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "Missing release folder:"
  echo "$RELEASE_DIR"
  echo
  echo "Run this first:"
  echo "npm run package:release"
  exit 1
fi

required=(
  "KanTrack-$VERSION-notarized-Apple-Silicon.zip"
  "KanTrack-$VERSION-notarized-Apple-Silicon.dmg"
  "KanTrack.app.tar.gz"
  "KanTrack.app.tar.gz.sig"
  "latest.json"
)

for file in "${required[@]}"; do
  if [[ ! -f "$RELEASE_DIR/$file" ]]; then
    echo "Missing release asset: $RELEASE_DIR/$file"
    exit 1
  fi
done

node <<NODE
const fs = require('fs');
const latest = JSON.parse(fs.readFileSync('$RELEASE_DIR/latest.json', 'utf8'));
const url = latest.platforms?.['darwin-aarch64']?.url;
if (latest.version !== '$VERSION') {
  console.error('latest.json version mismatch.');
  console.error('Expected: $VERSION');
  console.error('Actual:   ' + latest.version);
  process.exit(1);
}
if (url !== '$EXPECTED_URL') {
  console.error('latest.json updater URL mismatch.');
  console.error('Expected: $EXPECTED_URL');
  console.error('Actual:   ' + url);
  process.exit(1);
}
NODE

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI is not installed, so I cannot upload automatically."
  echo
  echo "Create the GitHub release manually with this exact tag:"
  echo "$TAG"
  echo
  echo "Upload these files from:"
  echo "$RELEASE_DIR"
  printf ' - %s\n' "${required[@]}"
  echo
  echo "Do not use uppercase V. The tag must be exactly: $TAG"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is installed but not logged in."
  echo "Run: gh auth login"
  exit 1
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG already exists. Uploading/replacing assets..."
  gh release upload "$TAG" \
    "$RELEASE_DIR/KanTrack-$VERSION-notarized-Apple-Silicon.zip" \
    "$RELEASE_DIR/KanTrack-$VERSION-notarized-Apple-Silicon.dmg" \
    "$RELEASE_DIR/KanTrack.app.tar.gz" \
    "$RELEASE_DIR/KanTrack.app.tar.gz.sig" \
    "$RELEASE_DIR/latest.json" \
    --repo "$REPO" \
    --clobber
else
  echo "Creating release $TAG and uploading assets..."
  gh release create "$TAG" \
    "$RELEASE_DIR/KanTrack-$VERSION-notarized-Apple-Silicon.zip" \
    "$RELEASE_DIR/KanTrack-$VERSION-notarized-Apple-Silicon.dmg" \
    "$RELEASE_DIR/KanTrack.app.tar.gz" \
    "$RELEASE_DIR/KanTrack.app.tar.gz.sig" \
    "$RELEASE_DIR/latest.json" \
    --repo "$REPO" \
    --title "KanTrack $VERSION" \
    --notes "KanTrack $VERSION"
fi

echo
echo "Published:"
echo "https://github.com/$REPO/releases/tag/$TAG"
