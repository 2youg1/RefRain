# WebView2 shell host (Tauri-equivalent engine). Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File host.ps1 -Shell wv2
param(
  [string]$Shell = 'wv2',
  [string]$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
)

$ErrorActionPreference = 'Stop'
$outDir = Join-Path $Root "results\$Shell"
New-Item -ItemType Directory -Force $outDir | Out-Null
$log = Join-Path $outDir 'host.log'
function Log($m) { [IO.File]::AppendAllText($log, "$(Get-Date -Format o) $m`n") }

try {
  $pkg = Join-Path $Root 'shells\wv2\wv2pkg'
  $env:PATH = "$(Join-Path $pkg 'runtimes\win-x64\native');$env:PATH"

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -Path (Join-Path $pkg 'lib\net462\Microsoft.Web.WebView2.Core.dll')
  Add-Type -Path (Join-Path $pkg 'lib\net462\Microsoft.Web.WebView2.WinForms.dll')
  Log 'assemblies loaded'

  $form = New-Object System.Windows.Forms.Form
  $form.StartPosition = 'Manual'
  $form.Location = New-Object System.Drawing.Point(60, 60)
  $form.Size = New-Object System.Drawing.Size(1100, 800)
  $form.Text = "IME-TEST $Shell boot"
  $form.TopMost = $true

  $script:wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
  $wv.Dock = 'Fill'
  $form.Controls.Add($wv)

  $ud = Join-Path $outDir 'wv2ud'
  Log 'creating environment...'
  $envTask = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync('', $ud, $null)
  while (-not $envTask.IsCompleted) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
  if ($envTask.IsFaulted) { throw $envTask.Exception }
  $wvEnv = $envTask.Result
  Log 'environment created'

  $wv.add_CoreWebView2InitializationCompleted({
    param($s, $e)
    try {
      if (-not $e.IsSuccess) { Log ("init failed: " + $e.InitializationException.Message); return }
      Log 'corewebview2 initialized, navigating'
      $page = 'file:///' + ($Root -replace '\\','/') + '/page/editor.html?shell=' + $Shell
      $wv.CoreWebView2.Navigate($page)
      $wv.CoreWebView2.add_DocumentTitleChanged({
        try { $form.BeginInvoke([Action]{ $form.Text = $wv.CoreWebView2.DocumentTitle }) } catch {}
      })
    } catch { Log ("init-completed handler err: " + $_.Exception.Message) }
  })

  Log 'ensuring corewebview2...'
  $initTask = $wv.EnsureCoreWebView2Async($wvEnv)
  while (-not $initTask.IsCompleted) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
  if ($initTask.IsFaulted) { throw $initTask.Exception }
  Log 'ensure completed'

  $script:pending = $null
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 1000
  $timer.add_Tick({
    try {
      if ($null -eq $wv.CoreWebView2) { return }
      if ($null -ne $script:pending) {
        if (-not $script:pending.IsCompleted) { return }
        try {
          $raw = $script:pending.Result
          if ($raw -and $raw -ne '""' -and $raw -ne 'null') {
            $json = $raw | ConvertFrom-Json
            if ($json) {
              [IO.File]::WriteAllText((Join-Path $outDir 'latest.json'), $json)
              [IO.File]::WriteAllText((Join-Path $outDir 'ready.flag'), [string][DateTimeOffset]::Now.ToUnixTimeMilliseconds())
            }
          }
        } catch { Log ("tick read err: " + $_.Exception.Message) }
        $script:pending = $null
        return
      }
      $script:pending = $wv.CoreWebView2.ExecuteScriptAsync('(window.__ime&&window.__ime.ready)?JSON.stringify(window.__getReport()):""')
    } catch { Log ("tick err: " + $_.Exception.Message); $script:pending = $null }
  })
  $timer.Start()
  Log 'entering message loop'
  [System.Windows.Forms.Application]::Run($form)
} catch {
  Log ("FATAL: " + $_.Exception.Message + "`n" + $_.ScriptStackTrace)
  exit 1
}
