# prepare.ps1: install harness deps, Electron binaries, WebView2 SDK; build the test page.
param([string]$Root = (Resolve-Path "$PSScriptRoot\..").Path)
$ErrorActionPreference = 'Stop'
Push-Location $Root
try {
  npm ci --no-audit --no-fund
  foreach ($s in 'e42', 'e43', 'e44') {
    Push-Location "shells\$s"
    npm ci --no-audit --no-fund
    Pop-Location
    if (-not (Test-Path "shells\$s\node_modules\electron\dist\electron.exe")) {
      Push-Location "shells\$s\node_modules\electron"
      node install.js
      Pop-Location
    }
    if (-not (Test-Path "shells\$s\node_modules\electron\dist\electron.exe")) { throw "electron binary missing for $s" }
  }
  & ".\node_modules\.bin\esbuild.cmd" page\editor.js --bundle --format=iife --outfile=page\editor.bundle.js
  node page\inject.js
  if (-not (Test-Path 'shells\wv2\wv2pkg\lib\net462\Microsoft.Web.WebView2.WinForms.dll')) {
    $zip = Join-Path $env:TEMP 'wv2.nupkg.zip'
    Invoke-WebRequest -Uri 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2' -OutFile $zip
    Expand-Archive -Force $zip (Join-Path $Root 'shells\wv2\wv2pkg')
  }
  Write-Host 'prepare OK'
} finally { Pop-Location }
