#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required. Install it from nodejs.org and rerun."
  exit 1
fi
mkdir -p desktop/icons
for f in index.html manifest.json ui.css ravi-fixes.js sw.js icon.png; do cp "$f" "desktop/$f"; done
cp -R icons/. desktop/icons/
node --check desktop/ravi-fixes.js
node --check desktop/sw.js
cd desktop
npm install
npx electron-builder --mac --arm64 --publish never
echo "Built DMG: $(pwd)/dist"
