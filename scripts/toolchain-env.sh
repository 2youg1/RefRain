#!/usr/bin/env bash
# Copyright (c) 2026 2youg1
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Toolchain for a development machine that has no C compiler.
#
# Cargo needs a linker, libc headers, and CRT objects. A machine with no `cc`
# and no root to install one has none of them, and rustup will report "Rust is
# installed now. Great!" while leaving you unable to link a single binary.
# Worse, a crate that produces only rlibs still builds, so a probe can come
# back green while every real target fails. Zig ships linker, headers, and CRT
# in one relocatable tarball, so cargo links through `zig cc` without root.
#
# CI needs none of this; GitHub's runners carry MSVC, clang, and gcc already.
#
# Usage:
#   REFRAIN_ZIG=/path/to/zig-dir source scripts/toolchain-env.sh
#
# where that directory holds two one-line shims, `zigcc` and `zigar`:
#
#   #!/bin/sh
#   exec /path/to/zig cc "$@"     # zigcc — rewrites the four-part triple
#   exec /path/to/zig ar "$@"     # zigar — this box has no binutils either

export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"

# Append rather than replace: an earlier version of this file overwrote PATH
# and took bun with it, so every command after `source` failed with "bun: not
# found" — a build break caused entirely by the script meant to enable it.
case ":$PATH:" in
  *":$CARGO_HOME/bin:"*) ;;
  *) export PATH="$CARGO_HOME/bin:$PATH" ;;
esac

# Left unset, this script configures cargo and nothing else, which is correct
# on any machine that has a working compiler.
if [ -n "${REFRAIN_ZIG:-}" ] && [ -x "$REFRAIN_ZIG/zigcc" ]; then
  case ":$PATH:" in
    *":$REFRAIN_ZIG:"*) ;;
    *) export PATH="$REFRAIN_ZIG:$PATH" ;;
  esac
  export CC="$REFRAIN_ZIG/zigcc"
  export CXX="$REFRAIN_ZIG/zigcc"
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="$REFRAIN_ZIG/zigcc"
  [ -x "$REFRAIN_ZIG/zigar" ] && export AR="$REFRAIN_ZIG/zigar"
fi

# Tauri's Linux build links gtk, webkit2gtk, libsoup, and dbus. Windows is the
# only release platform, so these are a development convenience: they let the
# generation chain and a real window run here. A sysroot unpacked without root
# needs PKG_CONFIG_PATH set explicitly — `pkg-config` on PATH is not enough,
# because a build script inherits the variable, not the shell's lookup.
#
# REFRAIN_SYSROOT is read from the environment rather than derived from $HOME:
# a background shell can run under a different HOME than the interactive one,
# and the failure then arrives as "dbus is not installed" pointing at a path
# nobody chose. Set it explicitly when HOME is not where the sysroot lives.
REFRAIN_SYSROOT="${REFRAIN_SYSROOT:-$HOME/.local/share/tauri-sysroot}"
if [ -d "$REFRAIN_SYSROOT/usr/lib/x86_64-linux-gnu/pkgconfig" ]; then
  export PKG_CONFIG_PATH="$REFRAIN_SYSROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$REFRAIN_SYSROOT/usr/share/pkgconfig:$REFRAIN_SYSROOT/usr/lib/pkgconfig"
  export PKG_CONFIG_SYSROOT_DIR="$REFRAIN_SYSROOT"
  case ":$PATH:" in
    *":$REFRAIN_SYSROOT/usr/bin:"*) ;;
    *) export PATH="$REFRAIN_SYSROOT/usr/bin:$PATH" ;;
  esac

  # The sysroot's own `pkg-config` links libpkgconf from the same tree. Without
  # this, it dies with exit 127 — and the pkg-config crate reports that as
  # "the system library was not found", which reads like a missing package and
  # sends you installing something that is already there. An interactive shell
  # often has this set already; a build script inherits only what is exported.
  case ":${LD_LIBRARY_PATH:-}:" in
    *":$REFRAIN_SYSROOT/usr/lib/x86_64-linux-gnu:"*) ;;
    *) export LD_LIBRARY_PATH="$REFRAIN_SYSROOT/usr/lib/x86_64-linux-gnu:$REFRAIN_SYSROOT/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  esac
fi
