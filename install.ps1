# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Copyright (c) 2026 2youg1 and the RefRain contributors

#Requires -Version 5.1

<#
.SYNOPSIS
    Install the published RefRain portable build for Windows x86-64.

.DESCRIPTION
    Downloads the release asset, verifies every file in it against the
    SHA256SUMS the archive carries, and unpacks it into a per-user directory.

    The verification is the point. `release.yml` puts SHA256SUMS, the release
    manifest and the CycloneDX SBOM inside the archive so that a recipient can
    check what they received without trusting the workflow that built it. This
    installer performs exactly that check and refuses to unpack an archive that
    fails it — a downloader that skips the sums turns a self-describing artifact
    back into an opaque one.

    Every RefRain release is published as a prerelease, so the GitHub
    `releases/latest` endpoint — which excludes prereleases — answers 404 here.
    The newest tag is read from the release list instead.

.PARAMETER Version
    A release tag such as `v0.0.4-Pre-alpha-260816`. Defaults to the newest
    published release, or to the REFRAIN_VERSION environment variable.

.PARAMETER Destination
    Where the product directory goes. Defaults to REFRAIN_HOME, then to
    %LOCALAPPDATA%\Programs\RefRain.

.EXAMPLE
    irm https://raw.githubusercontent.com/2youg1/RefRain/main/install.ps1 | iex

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -Version v0.0.4-Pre-alpha-260816
#>

param(
    [string] $Version = $env:REFRAIN_VERSION,
    [string] $Destination = $env:REFRAIN_HOME
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repository = '2youg1/RefRain'
$Asset = 'refrain-windows-x64.zip'
$ProductDirectory = 'RefRain'

function Write-Step([string] $Message) {
    Write-Host "==> $Message"
}

# Windows x86-64 is the only target this project builds. Naming the refusal is
# worth more than a generic failure later: the reason is that no other artifact
# exists, not that the script is fussy.
function Assert-SupportedHost {
    $onWindows = $true
    if (Test-Path Variable:IsWindows) { $onWindows = $IsWindows }
    if (-not $onWindows) {
        throw 'RefRain publishes a Windows x86-64 build only; no artifact exists for this platform.'
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'RefRain publishes an x86-64 build only; this Windows installation is 32-bit.'
    }
}

# The instruction floor the release is compiled for is x86-64-v2 — SSE4.2 and
# POPCNT, every x86-64 part since 2009. A machine below it launches and dies
# with 0xC000001D, which reads as a corrupt download rather than as what it is.
function Resolve-LatestTag {
    $uri = "https://api.github.com/repos/$Repository/releases?per_page=1"
    $releases = Invoke-RestMethod -Uri $uri -Headers @{ 'User-Agent' = 'refrain-install' }
    if (-not $releases -or $releases.Count -eq 0) {
        throw "no published release found at https://github.com/$Repository/releases"
    }
    return $releases[0].tag_name
}

# Every file the archive lists, hashed here and compared with what the release
# workflow recorded. A missing file is a failure, not a skip: a sums file whose
# entries do not all resolve proves nothing about the ones that do.
function Assert-Checksums([string] $Root) {
    $sums = Join-Path $Root 'SHA256SUMS'
    if (-not (Test-Path -LiteralPath $sums)) {
        throw "the archive carries no SHA256SUMS; refusing to install an unverifiable build"
    }
    $checked = 0
    foreach ($line in Get-Content -LiteralPath $sums) {
        if ($line.Trim() -eq '') { continue }
        $parts = $line -split '\s+', 2
        if ($parts.Count -ne 2) { throw "SHA256SUMS has an unreadable line: $line" }
        $expected = $parts[0].Trim()
        $relative = $parts[1].Trim()
        $file = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $file)) {
            throw "SHA256SUMS lists $relative, which the archive does not contain"
        }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash
        if ($actual -ne $expected.ToUpperInvariant()) {
            throw "$relative does not match its recorded digest; the download is not what was published"
        }
        $checked++
    }
    if ($checked -eq 0) {
        throw 'SHA256SUMS listed no files; the verification would have passed without checking anything'
    }
    Write-Step "$checked files match SHA256SUMS"
}

function Add-ToUserPath([string] $Directory) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @()
    if ($current) { $entries = $current -split ';' | Where-Object { $_ -ne '' } }
    if ($entries -contains $Directory) { return $false }
    $updated = (@($entries) + $Directory) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
    return $true
}

Assert-SupportedHost

Write-Host ''
Write-Host 'RefRain is unfinished and not usable for writing. Releases exist so the'
Write-Host 'author can test the packaging path end to end. Install it to look, not to work in.'
Write-Host ''

if (-not $Version) {
    Write-Step 'Resolving the newest published release'
    $Version = Resolve-LatestTag
}
if (-not $Destination) {
    $Destination = Join-Path $env:LOCALAPPDATA 'Programs\RefRain'
}

$url = "https://github.com/$Repository/releases/download/$Version/$Asset"
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("refrain-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
    $archive = Join-Path $work $Asset
    Write-Step "Downloading $Version"
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing

    $unpacked = Join-Path $work 'unpacked'
    Write-Step 'Unpacking'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked -Force

    $product = Join-Path $unpacked $ProductDirectory
    if (-not (Test-Path -LiteralPath $product)) {
        throw "the archive does not contain a $ProductDirectory directory"
    }
    Assert-Checksums -Root $unpacked

    Write-Step "Installing into $Destination"
    if (Test-Path -LiteralPath $Destination) { Remove-Item -Recurse -Force -LiteralPath $Destination }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Move-Item -LiteralPath $product -Destination $Destination

    $bin = Join-Path $Destination 'bin'
    $executable = Join-Path $bin 'refrain.exe'
    if (-not (Test-Path -LiteralPath $executable)) {
        throw "installed, but $executable is missing; the archive layout has changed"
    }

    if (Add-ToUserPath -Directory $bin) {
        Write-Step 'Added the bin directory to your user PATH; open a new terminal to pick it up'
    }

    Write-Host ''
    Write-Host "RefRain $Version is installed at $Destination"
    Write-Host "Run it with: $executable"
    Write-Host ''
}
finally {
    Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
}
