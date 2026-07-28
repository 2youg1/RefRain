#!/usr/bin/env bash
# Backwards-compatible Unix entry point. The build itself lives in Bun so the
# same command runs on Windows without Git Bash.
set -e
cd "$(dirname "$0")"
exec bun scripts/build-desktop.ts
