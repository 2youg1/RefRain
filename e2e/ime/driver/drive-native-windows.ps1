param(
  [string]$Root = "",
  # `native` is the only shell the product has. It is named explicitly so the
  # CI step says which surface it drove: an embedded-browser shell existed here
  # once, and a run that silently changed surface read as the same green.
  [ValidateSet("native")]
  [string]$Shell = "native",
  [string]$Binary = "apps/native/zig-out/bin/refrain.exe"
)

$ErrorActionPreference = "Stop"
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path }
$Root = (Resolve-Path $Root).Path
$Executable = (Resolve-Path (Join-Path $Root $Binary)).Path
$NativeDir = Join-Path $Root "apps/native"
$RelativeResultRoot = "e2e/ime/results/native/windows"
$ResultRoot = Join-Path $Root $RelativeResultRoot
$FixtureRoot = Join-Path $ResultRoot "fixture"
$RuntimeLog = Join-Path $ResultRoot "runtime.stderr.log"
$RuntimeOut = Join-Path $ResultRoot "runtime.stdout.log"
$IdentityPath = Join-Path $ResultRoot "identity.json"
$ManifestPath = Join-Path $ResultRoot "run.json"
$DocumentPath = Join-Path $FixtureRoot "document.md"

Remove-Item $ResultRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item $FixtureRoot -ItemType Directory -Force | Out-Null
[IO.File]::WriteAllText($DocumentPath, "第一行`n`n第二行", [Text.UTF8Encoding]::new($false))

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeImeWin {
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool enable);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public struct POINT { public int X; public int Y; }
}
"@

function Tap([int]$Key, [int]$HoldMs = 35) {
  [NativeImeWin]::keybd_event([byte]$Key, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $HoldMs
  [NativeImeWin]::keybd_event([byte]$Key, 0, 2, [UIntPtr]::Zero)
}

function Type-Letters([string]$Value, [int]$GapMs = 100) {
  foreach ($character in $Value.ToCharArray()) {
    Tap ([int][char]::ToUpper($character)) 25
    Start-Sleep -Milliseconds $GapMs
  }
}

function Force-Foreground([IntPtr]$Window) {
  $foreground = [NativeImeWin]::GetForegroundWindow()
  $unusedPid = [uint32]0
  $foregroundThread = [NativeImeWin]::GetWindowThreadProcessId($foreground, [ref]$unusedPid)
  $targetThread = [NativeImeWin]::GetWindowThreadProcessId($Window, [ref]$unusedPid)
  $currentThread = [NativeImeWin]::GetCurrentThreadId()
  [NativeImeWin]::AttachThreadInput($currentThread, $targetThread, $true) | Out-Null
  [NativeImeWin]::AttachThreadInput($foregroundThread, $targetThread, $true) | Out-Null
  [NativeImeWin]::SetForegroundWindow($Window) | Out-Null
  [NativeImeWin]::AttachThreadInput($currentThread, $targetThread, $false) | Out-Null
  [NativeImeWin]::AttachThreadInput($foregroundThread, $targetThread, $false) | Out-Null
}

function Click-Client([IntPtr]$Window, [int]$X, [int]$Y) {
  $point = New-Object NativeImeWin+POINT
  $point.X = $X
  $point.Y = $Y
  if (-not [NativeImeWin]::ClientToScreen($Window, [ref]$point)) {
    throw "ClientToScreen failed"
  }
  [NativeImeWin]::SetCursorPos($point.X, $point.Y) | Out-Null
  [NativeImeWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [NativeImeWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Capture-Screen([string]$Path) {
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Invoke-NativeAutomation([string[]]$CommandArgs, [string]$ErrorPath) {
  $lines = $null
  $exitCode = 1
  Push-Location $NativeDir
  try {
    $lines = & bun x native automate @CommandArgs 2> $ErrorPath
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  $stderr = if (Test-Path $ErrorPath) { Get-Content $ErrorPath -Raw } else { "" }
  Remove-Item $ErrorPath -Force -ErrorAction SilentlyContinue
  return [PSCustomObject]@{
    Lines = $lines
    ExitCode = $exitCode
    Stderr = $stderr
  }
}

function Native-Snapshot([int]$PublisherPid, [string]$Name, [string]$Required = "") {
  $path = Join-Path $ResultRoot "$Name.snapshot.txt"
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $errorPath = Join-Path $ResultRoot "automation.stderr.tmp"
    $attempt = Invoke-NativeAutomation @("snapshot") $errorPath
    $snapshot = ($attempt.Lines -join "`n")
    $allowedDelivery = "delivered snapshot -> "
    if ($attempt.ExitCode -eq 0 -and ($attempt.Stderr.Length -eq 0 -or $attempt.Stderr.StartsWith($allowedDelivery)) -and
        $snapshot -match "ready=true" -and $snapshot -match "publisher_pid=$PublisherPid(?:\s|$)" -and
        $snapshot -match "dispatch_errors=0" -and $snapshot -match "gpu_nonblank=true" -and
        ($Required.Length -eq 0 -or $snapshot -match $Required)) {
      [IO.File]::WriteAllText($path, "$snapshot`n", [Text.UTF8Encoding]::new($false))
      return $snapshot
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw "Native snapshot $Name did not prove the required runtime state"
}

function Start-Composition([int]$PublisherPid, [string]$Name, [string]$Letters) {
  foreach ($attempt in 1..4) {
    Type-Letters $Letters
    try { return Native-Snapshot $PublisherPid $Name "composition=\d+\.\.\d+.*caret=\(" } catch {}
    Tap 0x1B
    Tap 0x08
    if ($attempt -eq 1) { Tap 0x10 60 }
    elseif ($attempt -eq 2) {
      [NativeImeWin]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
      Tap 0x20
      [NativeImeWin]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    } else {
      [NativeImeWin]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
      Tap 0x20
      [NativeImeWin]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
    }
  }
  throw "The Windows IME did not create a Native composition"
}

$tip = "0804:{81D4E9C9-1D3B-41BC-9E6C-4B40BF79E35E}{FA550B04-5AD7-411F-A5AC-CA038EC515D7}"
$languages = Get-WinUserLanguageList
$installed = @($languages | Where-Object LanguageTag -eq "zh-Hans-CN").Count -gt 0
if (-not $installed) { throw "zh-Hans-CN is not installed" }
Set-WinDefaultInputMethodOverride -InputTip $tip

Push-Location $Root
$process = $null
try {
  & bun e2e/ime/capture-native-identity.ts --root $Root --executable $Executable --output $IdentityPath
  if ($LASTEXITCODE -ne 0) { throw "identity capture failed" }

  $env:NATIVE_SDK_IME_EVIDENCE = "1"
  $env:REFRAIN_NATIVE_ROOT = $FixtureRoot
  $env:REFRAIN_NATIVE_DOCUMENT = "document.md"
  $env:REFRAIN_NATIVE_APP_DB = (Join-Path $FixtureRoot "app.db")
  $process = Start-Process $Executable -PassThru -RedirectStandardError $RuntimeLog -RedirectStandardOutput $RuntimeOut

  $initial = Native-Snapshot $process.Id "initial" "role=textbox name=`"RefRain manuscript`""
  $window = [IntPtr]::Zero
  $deadline = (Get-Date).AddSeconds(20)
  while ($window -eq [IntPtr]::Zero) {
    $window = (Get-Process -Id $process.Id -ErrorAction Stop).MainWindowHandle
    if ((Get-Date) -gt $deadline) { throw "Native process has no main window" }
    Start-Sleep -Milliseconds 100
  }
  if ((Get-Process -Id $process.Id).MainWindowTitle -ne "RefRain") {
    throw "The launched process is not the RefRain Native window"
  }
  [NativeImeWin]::ShowWindow($window, 9) | Out-Null
  Force-Foreground $window

  $bounds = [regex]::Match($initial, 'role=textbox name="RefRain manuscript" bounds=\(([-0-9.]+),([-0-9.]+) ([0-9.]+)x([0-9.]+)\)')
  if (-not $bounds.Success) { throw "Native snapshot has no manuscript bounds" }
  $editorX = [int][double]$bounds.Groups[1].Value
  $editorY = [int][double]$bounds.Groups[2].Value

  Click-Client $window ($editorX + 80) ($editorY + 20)
  Start-Sleep -Milliseconds 300
  $preedit = Start-Composition $process.Id "preedit" "ni"
  Capture-Screen (Join-Path $ResultRoot "preedit.png")
  Tap 0x1B
  Native-Snapshot $process.Id "after-first-cancel" "role=textbox.*focused=true"

  Click-Client $window ($editorX + 80) ($editorY + 60)
  Start-Sleep -Milliseconds 300
  $moved = Start-Composition $process.Id "movedPreedit" "nihao"
  Capture-Screen (Join-Path $ResultRoot "moved-preedit.png")
  Tap 0x20
  Native-Snapshot $process.Id "committed" "role=textbox.*focused=true"

  Start-Composition $process.Id "cancelPreedit" "ceshi" | Out-Null
  Tap 0x1B
  Native-Snapshot $process.Id "cancelled" "role=textbox.*focused=true"

  foreach ($key in @(@(0xBC,$false), @(0xBE,$false), @(0xBF,$true), @(0x31,$true))) {
    if ($key[1]) { [NativeImeWin]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero) }
    Tap ([int]$key[0])
    if ($key[1]) { [NativeImeWin]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 250
  }
  $punctuation = Native-Snapshot $process.Id "punctuation" "role=textbox.*focused=true"

  $save = [regex]::Match($punctuation, 'widget @w1/document#([0-9]+) role=button name="Save"')
  if (-not $save.Success) { throw "Native snapshot has no Save button" }
  $saveAttempt = Invoke-NativeAutomation @("widget-click", "document", $save.Groups[1].Value) (Join-Path $ResultRoot "save.automation.stderr.txt")
  if ($saveAttempt.ExitCode -ne 0 -or
      ($saveAttempt.Stderr.Length -gt 0 -and -not $saveAttempt.Stderr.StartsWith("delivered widget-click -> "))) {
    throw "Native Save action failed"
  }
  Start-Sleep -Milliseconds 500

  $preeditHash = (Get-FileHash (Join-Path $ResultRoot "preedit.png") -Algorithm SHA256).Hash.ToLowerInvariant()
  $movedHash = (Get-FileHash (Join-Path $ResultRoot "moved-preedit.png") -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifest = [ordered]@{
    schemaVersion = 1
    implementation = "native-rust-document-surface"
    platform = "windows"
    processId = $process.Id
    executablePath = (Resolve-Path -Relative $Executable)
    identityPath = "$RelativeResultRoot/identity.json"
    runtimeLogPath = "$RelativeResultRoot/runtime.stderr.log"
    finalDocumentPath = "$RelativeResultRoot/fixture/document.md"
    resultPath = "$RelativeResultRoot/result.json"
    snapshots = [ordered]@{
      preedit = "$RelativeResultRoot/preedit.snapshot.txt"
      movedPreedit = "$RelativeResultRoot/movedPreedit.snapshot.txt"
      committed = "$RelativeResultRoot/committed.snapshot.txt"
      cancelPreedit = "$RelativeResultRoot/cancelPreedit.snapshot.txt"
      cancelled = "$RelativeResultRoot/cancelled.snapshot.txt"
      punctuation = "$RelativeResultRoot/punctuation.snapshot.txt"
    }
    screenshots = [ordered]@{
      preedit = [ordered]@{ path = "$RelativeResultRoot/preedit.png"; sha256 = $preeditHash }
      movedPreedit = [ordered]@{ path = "$RelativeResultRoot/moved-preedit.png"; sha256 = $movedHash }
    }
    inputMethod = [ordered]@{
      locale = "zh-Hans-CN"
      identifier = $tip
      installed = $installed
      active = $true
      inputSource = "os"
    }
    expected = [ordered]@{ committedText = "你好"; punctuation = "，。？！" }
  }
  [IO.File]::WriteAllText($ManifestPath, "$($manifest | ConvertTo-Json -Depth 8)`n", [Text.UTF8Encoding]::new($false))
  & bun e2e/ime/assert-native.ts --root $Root --manifest "$RelativeResultRoot/run.json"
  if ($LASTEXITCODE -ne 0) { throw "Native Windows IME evidence failed" }
} finally {
  if ($null -ne $process) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  Pop-Location
}
