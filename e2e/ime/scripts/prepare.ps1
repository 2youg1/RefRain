# prepare.ps1: fetch the WebView2 WinForms assemblies and build the test page.
param([string]$Root = '')
$ErrorActionPreference = 'Stop'
# $PSScriptRoot is empty inside a param default (PowerShell 5.1).
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
Push-Location $Root
try {
  bun page\build.ts
  if (-not (Test-Path 'shells\wv2\wv2pkg\lib\net462\Microsoft.Web.WebView2.WinForms.dll')) {
    $zip = Join-Path $env:TEMP 'wv2.nupkg.zip'
    Invoke-WebRequest -Uri 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2' -OutFile $zip
    Expand-Archive -Force $zip (Join-Path $Root 'shells\wv2\wv2pkg')
  }
  Write-Host 'prepare OK'
} finally { Pop-Location }
