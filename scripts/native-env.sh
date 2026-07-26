#!/usr/bin/env bash
# Toolchain for RefRain's native layer.
#
# This machine has no C compiler, no libc headers, and no root to install them.
# Zig ships all three in one relocatable tarball, so cargo links through zig cc.
# Source this file before any cargo invocation.
#
# CI needs none of this: GitHub's runners carry MSVC, clang, and gcc already.
# The Zig detour exists for development boxes without a system toolchain.

export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"

# Fall back to the sandbox install when the default location is empty.
if [ ! -x "$CARGO_HOME/bin/cargo" ] && [ -x /hermes/profiles/nothin/home/.cargo/bin/cargo ]; then
  export CARGO_HOME=/hermes/profiles/nothin/home/.cargo
  export RUSTUP_HOME=/hermes/profiles/nothin/home/.rustup
fi

# Append rather than replace: an earlier version of this file overwrote PATH
# and took bun with it, so every command after `source` failed with "bun: not
# found" — a build break caused entirely by the script meant to enable it.
case ":$PATH:" in
  *":$CARGO_HOME/bin:"*) ;;
  *) export PATH="$CARGO_HOME/bin:$PATH" ;;
esac

if [ -x /workspace/.zig/zigcc ]; then
  case ":$PATH:" in
    *":/workspace/.zig:"*) ;;
    *) export PATH="/workspace/.zig:$PATH" ;;
  esac
  export CC=/workspace/.zig/zigcc
  export CXX=/workspace/.zig/zigcc
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=/workspace/.zig/zigcc
fi
