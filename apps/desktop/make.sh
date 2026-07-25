#!/usr/bin/env bash
# Build both halves of the desktop app. The renderer goes through Vite; main and
# preload through Bun, bundled to CommonJS and named .cjs so Electron loads them
# despite this package declaring "type": "module".
set -e
cd "$(dirname "$0")"

./node_modules/.bin/vite build

bun build src/main/main.ts --target=node --outdir=dist/main --format=cjs --external electron
bun build src/main/preload.ts --target=node --outdir=dist/main --format=cjs --external electron
mv dist/main/main.js dist/main/main.cjs
mv dist/main/preload.js dist/main/preload.cjs

echo "BUILD_OK"
