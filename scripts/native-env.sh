#!/usr/bin/env bash
# Toolchain for RefRain's native layer, on a machine that has no C compiler.
#
# `cargo build` needs a linker, libc headers, and CRT objects. A machine with
# no `cc` and no root to install one has none of them, and rustup will happily
# report "Rust is installed now. Great!" while leaving you unable to link a
# single binary. Zig ships all three in one relocatable tarball, so cargo can
# link through `zig cc` without touching the system.
#
# CI needs none of this: GitHub's runners carry MSVC, clang, and gcc already.
# This exists for development boxes without a system toolchain.
#
# Usage:
#   REFRAIN_ZIG=/path/to/zig-dir source scripts/native-env.sh
#
# where the directory holds a `zigcc` shim one line long:
#
#   #!/bin/sh
#   exec /path/to/zig cc "$@"

export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"

# Append rather than replace: an earlier version of this file overwrote PATH
# and took bun with it, so every command after `source` failed with "bun: not
# found" — a build break caused entirely by the script meant to enable it.
case ":$PATH:" in
  *":$CARGO_HOME/bin:"*) ;;
  *) export PATH="$CARGO_HOME/bin:$PATH" ;;
esac

# Point REFRAIN_ZIG at the directory holding the shim. Left unset, this script
# configures cargo and nothing else, which is correct on any machine that has
# a working compiler.
if [ -n "${REFRAIN_ZIG:-}" ] && [ -x "$REFRAIN_ZIG/zigcc" ]; then
  case ":$PATH:" in
    *":$REFRAIN_ZIG:"*) ;;
    *) export PATH="$REFRAIN_ZIG:$PATH" ;;
  esac
  export CC="$REFRAIN_ZIG/zigcc"
  export CXX="$REFRAIN_ZIG/zigcc"
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="$REFRAIN_ZIG/zigcc"
fi
