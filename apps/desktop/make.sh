#!/usr/bin/env bash
# Build both halves of the desktop app. The renderer goes through Vite; main and
# preload through Bun, bundled to CommonJS and named .cjs so Electron loads them
# despite this package declaring "type": "module".
#
# Binaries resolve through `bun x` rather than a node_modules path: bun hoists
# differently on Windows than on Linux, so a hardcoded path works on one and
# fails on the other.
set -e
cd "$(dirname "$0")"

bun x vite build

bun build src/main/main.ts --target=node --outdir=dist/main --format=cjs --external electron
bun build src/main/preload.ts --target=node --outdir=dist/main --format=cjs --external electron
mv -f dist/main/main.js dist/main/main.cjs
mv -f dist/main/preload.js dist/main/preload.cjs

# core targets two runtimes; this proves the Node branch of the SQLite adapter,
# which `bun test` cannot reach.
bun build scripts/node-ledger-check.ts --target=node --outdir=dist/checks --format=cjs
mv -f dist/checks/node-ledger-check.js dist/checks/node-ledger-check.cjs
node dist/checks/node-ledger-check.cjs

echo "BUILD_OK"
