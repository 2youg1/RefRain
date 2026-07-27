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

# The main process is bundled for Node; a Bun global in it is a runtime crash
# that no test can see. This shipped once already.
bun scripts/verify-no-bun.ts

# core targets two runtimes; this proves the branch the shipped Electron main
# process takes. `bun test` proves only the Bun SQLite adapter, while a system
# `node` can differ from Electron's embedded Node and let an unavailable
# `node:sqlite` cross the release gate. Run Electron as its own headless Node so
# the probe exercises the exact executable without needing a display server.
bun build scripts/node-ledger-check.ts --target=node --outdir=dist/checks --format=cjs
mv -f dist/checks/node-ledger-check.js dist/checks/node-ledger-check.cjs
ELECTRON_RUN_AS_NODE=1 bun x electron dist/checks/node-ledger-check.cjs

# electron-builder only warns when the icon is missing and ships the default
# Electron one, which reaches a user as a released application wearing another
# project's mark. The icon is committed; this catches its removal.
if [ ! -s build/icon.png ]; then
  echo "MISSING build/icon.png — run 'bun scripts/make-icon.ts'" >&2
  exit 1
fi

echo "BUILD_OK"
