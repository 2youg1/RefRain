#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Copyright (c) 2026 2youg1 and the RefRain contributors

# Install the published RefRain portable build, from a Windows shell.
#
#   curl -fsSL https://raw.githubusercontent.com/2youg1/RefRain/main/install.sh | sh
#
# This is the same procedure `install.ps1` performs, for people who work in Git
# Bash, MSYS2 or Cygwin rather than in PowerShell. It downloads the release
# asset, verifies every file against the SHA256SUMS the archive carries, and
# unpacks it into a per-user directory.
#
# The verification is not decoration. `release.yml` puts SHA256SUMS, the release
# manifest and the CycloneDX SBOM inside the archive so a recipient can check
# what they received without trusting the workflow that built it; an installer
# that skips the sums turns a self-describing artifact back into an opaque one.
#
# It refuses to run anywhere but a Windows shell, and says why: RefRain builds a
# Windows x86-64 artifact and nothing else, so on Linux or macOS there is no
# file for this script to fetch. Nothing is claimed for a platform this project
# has not measured.
#
# Environment:
#   REFRAIN_VERSION  a release tag; defaults to the newest published release
#   REFRAIN_HOME     where the product goes; defaults to
#                    %LOCALAPPDATA%/Programs/RefRain

set -eu

repository="2youg1/RefRain"
asset="refrain-windows-x64.zip"
product="RefRain"

step() { printf '==> %s\n' "$1"; }
fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

need() {
	command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not on PATH"
}

case "$(uname -s 2>/dev/null || echo unknown)" in
MINGW* | MSYS* | CYGWIN* | Windows_NT) ;;
*)
	fail "RefRain publishes a Windows x86-64 build only; no artifact exists for this platform."
	;;
esac

need curl
need unzip

# One of the two, in this order. `sha256sum` ships with Git Bash and MSYS2;
# `shasum` is the fallback a trimmed install may have instead. A host with
# neither cannot verify the download, and this script does not install what it
# cannot verify.
if command -v sha256sum >/dev/null 2>&1; then
	digest() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
	digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
	fail "neither sha256sum nor shasum is available; the download could not be verified"
fi

printf '\n'
printf 'RefRain is unfinished and not usable for writing. Releases exist so the\n'
printf 'author can test the packaging path end to end. Install it to look, not to work in.\n'
printf '\n'

# Every RefRain release is published as a prerelease, and the GitHub
# `releases/latest` endpoint excludes prereleases — it answers 404 for this
# repository. The newest tag is read from the release list instead.
version="${REFRAIN_VERSION:-}"
if [ -z "$version" ]; then
	step "Resolving the newest published release"
	version=$(
		curl -fsSL -H "User-Agent: refrain-install" \
			"https://api.github.com/repos/${repository}/releases?per_page=1" |
			sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
			head -n 1
	)
	[ -n "$version" ] || fail "no published release found at https://github.com/${repository}/releases"
fi

destination="${REFRAIN_HOME:-${LOCALAPPDATA:-$HOME}/Programs/${product}}"

work=$(mktemp -d 2>/dev/null || mktemp -d -t refrain-install)
trap 'rm -rf "$work"' EXIT INT TERM

step "Downloading ${version}"
curl -fsSL -o "${work}/${asset}" \
	"https://github.com/${repository}/releases/download/${version}/${asset}"

step "Unpacking"
unzip -q "${work}/${asset}" -d "${work}/unpacked"
[ -d "${work}/unpacked/${product}" ] ||
	fail "the archive does not contain a ${product} directory"

# A sums file whose entries do not all resolve proves nothing about the ones
# that do, so a missing file is a failure rather than a skip, and a sums file
# that listed nothing is a failure that would otherwise read as a pass.
step "Verifying every file against SHA256SUMS"
sums="${work}/unpacked/SHA256SUMS"
[ -f "$sums" ] ||
	fail "the archive carries no SHA256SUMS; refusing to install an unverifiable build"
checked=0
while read -r expected relative; do
	[ -n "${expected:-}" ] || continue
	file="${work}/unpacked/${relative}"
	[ -f "$file" ] || fail "SHA256SUMS lists ${relative}, which the archive does not contain"
	actual=$(digest "$file")
	[ "$actual" = "$expected" ] ||
		fail "${relative} does not match its recorded digest; the download is not what was published"
	checked=$((checked + 1))
done <"$sums"
[ "$checked" -gt 0 ] ||
	fail "SHA256SUMS listed no files; the verification would have passed without checking anything"
step "${checked} files match SHA256SUMS"

step "Installing into ${destination}"
rm -rf "$destination"
mkdir -p "$(dirname "$destination")"
mv "${work}/unpacked/${product}" "$destination"

executable="${destination}/bin/refrain.exe"
[ -f "$executable" ] ||
	fail "installed, but ${executable} is missing; the archive layout has changed"

printf '\n'
printf 'RefRain %s is installed at %s\n' "$version" "$destination"
printf 'Run it with: %s\n' "$executable"
printf 'Add it to PATH with: export PATH="%s/bin:$PATH"\n' "$destination"
printf '\n'
