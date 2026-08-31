# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Copyright (c) 2026 2youg1 and the RefRain contributors

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
$AutomationDir = Join-Path $NativeDir ".zig-cache/native-sdk-automation"
$NativeCli = Join-Path $NativeDir "node_modules/.bin/native.exe"

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
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr LoadKeyboardLayout(string id, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);
  public struct POINT { public int X; public int Y; }
}
"@

<#
  Put the running IME into Chinese mode, and prove it went.

  Tapping Shift / Ctrl+Space / Win+Space only *toggles*: with Microsoft Pinyin
  already in 英文模式 the lane typed `ni` as two Latin characters into the
  manuscript and no composition ever existed — which is what this lane kept
  reporting as "the IME did not create a composition". The conversion mode is
  a readable, writable piece of state: WM_IME_CONTROL against the thread's
  default IME window sets it cross-process and reads it back, so the lane
  asserts the mode instead of hoping a toggle landed the right way round.

  IME_CMODE_NATIVE selects Chinese over Latin; IME_CMODE_SYMBOL selects the
  Chinese punctuation this lane later types (，。？！).
#>
function Set-ImeChineseMode([IntPtr]$Window) {
  # The layout comes first. `Set-WinDefaultInputMethodOverride` only names the
  # default for threads created afterwards, and the runtime's window thread kept
  # the Latin layout that was active when the desktop session started: every
  # keystroke arrived as WM_CHAR, the manuscript grew the literal letters `ni`,
  # and no WM_IME_STARTCOMPOSITION ever reached the host. Asking the window to
  # change its input language names the layout instead of hoping for it.
  $KLF_ACTIVATE = 0x00000001
  $WM_INPUTLANGCHANGEREQUEST = 0x0050
  $chinese = [NativeImeWin]::LoadKeyboardLayout("00000804", $KLF_ACTIVATE)
  if ($chinese -ne [IntPtr]::Zero) {
    [NativeImeWin]::SendMessage($Window, $WM_INPUTLANGCHANGEREQUEST, [IntPtr]0, $chinese) | Out-Null
  }
  $WM_IME_CONTROL = 0x0283
  $IMC_GETCONVERSIONMODE = [IntPtr]0x0001
  $IMC_SETCONVERSIONMODE = [IntPtr]0x0002
  $IME_CMODE_NATIVE = 0x0001
  $IME_CMODE_SYMBOL = 0x0400
  $wanted = $IME_CMODE_NATIVE -bor $IME_CMODE_SYMBOL
  $deadline = (Get-Date).AddSeconds(10)
  do {
    $ime = [NativeImeWin]::ImmGetDefaultIMEWnd($Window)
    if ($ime -ne [IntPtr]::Zero) {
      [NativeImeWin]::SendMessage($ime, $WM_IME_CONTROL, $IMC_SETCONVERSIONMODE, [IntPtr]$wanted) | Out-Null
      $observed = [int][NativeImeWin]::SendMessage($ime, $WM_IME_CONTROL, $IMC_GETCONVERSIONMODE, [IntPtr]::Zero)
      $unusedPid = [uint32]0
      $windowThread = [NativeImeWin]::GetWindowThreadProcessId($Window, [ref]$unusedPid)
      $layout = [NativeImeWin]::GetKeyboardLayout($windowThread)
      $language = [int]$layout -band 0xffff
      if (($observed -band $IME_CMODE_NATIVE) -eq $IME_CMODE_NATIVE -and $language -eq 0x0804) { return $observed }
    }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw "The Windows IME stayed in Latin mode: ImmGetDefaultIMEWnd=$ime conversion=$observed language=0x$('{0:x4}' -f $language)"
}

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

<#
  Run one automation command through the same CLI every other lane runs.

  Two things are deliberate. The CLI is the workspace binary, not `bun x` —
  `verify-native-document-performance.ts` and the journal lanes all spawn
  apps/native/node_modules/.bin/native, and a second resolution path is a
  second thing that can differ. And `$ErrorActionPreference` drops to Continue
  for the call: PowerShell turns a native command's stderr into a terminating
  error under Stop, so the first probe against a runtime that has not finished
  starting killed the whole lane instead of being retried.
#>
function Invoke-NativeAutomation([string[]]$CommandArgs, [string]$ErrorPath) {
  $outPath = "$ErrorPath.out"
  # `& cli 2> file` writes PowerShell's *rendering* of the error stream, not the
  # bytes the CLI wrote: every line arrives wrapped as an ErrorRecord
  # (`native.exe : delivered widget-click -> …` followed by an `At …` block), so
  # a delivery line could never match the delivery pattern and every click read
  # as a failure. Start-Process redirects the real handles, and both files are
  # decoded as UTF-8 — the console codepage would mojibake the Chinese names
  # this lane matches on.
  $started = Start-Process $NativeCli -ArgumentList (@("automate") + $CommandArgs) `
    -WorkingDirectory $NativeDir -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $outPath -RedirectStandardError $ErrorPath
  $stdout = if (Test-Path $outPath) { [IO.File]::ReadAllText($outPath, [Text.UTF8Encoding]::new($false)) } else { "" }
  $stderr = if (Test-Path $ErrorPath) { [IO.File]::ReadAllText($ErrorPath, [Text.UTF8Encoding]::new($false)) } else { "" }
  Remove-Item $ErrorPath, $outPath -Force -ErrorAction SilentlyContinue
  return [PSCustomObject]@{
    Lines = $stdout -split "`r?`n"
    ExitCode = $started.ExitCode
    Stderr = $stderr.Trim()
  }
}

function Native-Snapshot([int]$PublisherPid, [string]$Name, [string]$Required = "") {
  $path = Join-Path $ResultRoot "$Name.snapshot.txt"
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $errorPath = Join-Path $ResultRoot "automation.stderr.tmp"
    $attempt = Invoke-NativeAutomation @("snapshot") $errorPath
    # Read the delivered file as UTF-8 rather than the command's stdout: Windows
    # PowerShell decodes a child process's output with the console codepage, and
    # every accessible name on this surface is Chinese — a pattern naming one
    # could never match a mojibake'd line, and the whole lane would look like a
    # timeout instead of an encoding.
    $deliveredPath = Join-Path $AutomationDir "snapshot.txt"
    $snapshot = if (Test-Path $deliveredPath) {
      [IO.File]::ReadAllText($deliveredPath, [Text.UTF8Encoding]::new($false))
    } else {
      ($attempt.Lines -join "`n")
    }
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
  # Keep what was actually seen. A bare "did not prove" says only that thirty
  # seconds passed, which is the least useful sentence a failing lane can print.
  [IO.File]::WriteAllText((Join-Path $ResultRoot "$Name.unmatched.txt"), "$snapshot`n", [Text.UTF8Encoding]::new($false))
  throw "Native snapshot $Name did not prove the required runtime state (wanted /$Required/, saw $RelativeResultRoot/$Name.unmatched.txt)"
}

<#
  Click the one widget a pattern names, once the snapshot proves it is there.

  The lane needs two clicks before it can type anything — adopt the folder, open
  the document — and both must wait for their row rather than sleep and hope.
#>
function Native-Click-Named([int]$PublisherPid, [string]$Name, [string]$Pattern) {
  $snapshot = Native-Snapshot $PublisherPid $Name $Pattern
  $found = [regex]::Match($snapshot, "widget @w1/document#([0-9]+) $Pattern")
  if (-not $found.Success) { throw "Native snapshot $Name has no widget matching $Pattern" }
  $errorPath = Join-Path $ResultRoot "$Name.automation.stderr.txt"
  $attempt = Invoke-NativeAutomation @("widget-click", "document", $found.Groups[1].Value) $errorPath
  if ($attempt.ExitCode -ne 0 -or
      ($attempt.Stderr.Length -gt 0 -and -not $attempt.Stderr.StartsWith("delivered widget-click -> "))) {
    throw "Native click $Name failed (exit $($attempt.ExitCode)) stderr=[$($attempt.Stderr)] stdout=[$($attempt.Lines -join '|')]"
  }
}

<#
  Type `$Letters` and wait for the runtime to report a composition range.

  Between attempts the mode is re-asserted rather than toggled: a toggle that
  fires while the mode is already right walks the IME back into Latin, and the
  next attempt then types Latin again — the failure this lane lived in. Escape
  cancels any half-built preedit and one backspace per typed letter removes
  anything that landed as literal text, so attempt N+1 starts from the same
  manuscript attempt N did.
#>
function Start-Composition([int]$PublisherPid, [string]$Name, [string]$Letters) {
  foreach ($attempt in 1..4) {
    Type-Letters $Letters
    try { return Native-Snapshot $PublisherPid $Name "composition=\d+\.\.\d+.*caret=\(" } catch {}
    Tap 0x1B
    foreach ($unused in 1..$Letters.Length) { Tap 0x08 }
    Set-ImeChineseMode $Window | Out-Null
    Start-Sleep -Milliseconds 200
  }
  throw "The Windows IME did not create a Native composition after four attempts"
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

  # The two names this used to set (REFRAIN_NATIVE_ROOT / _DOCUMENT) have had no
  # reader since v0.2.5, so the app came up with nothing open and the first
  # snapshot waited thirty seconds for a manuscript textbox that could not
  # exist. The document is opened the way an author opens one: the automation
  # channel answers "which folder", every other step is a real click.
  $env:NATIVE_SDK_IME_EVIDENCE = "1"
  $env:REFRAIN_AUTOMATION_ROOT = $FixtureRoot
  $env:REFRAIN_DATA_DIR = (Join-Path $ResultRoot "appdata")
  # The runtime publishes its automation channel under **its own** working
  # directory, and every reader here (and `native automate`) looks under
  # apps/native. Launched from the repository root this lane published to
  # RefRain/.zig-cache/native-sdk-automation, so each snapshot request read a
  # previous run's file, no publisher_pid ever matched, and a wrong directory
  # read as a thirty-second timeout. `run-native-document-performance.ts`
  # spawns with `cwd: nativeDir` for exactly this reason — same mechanism here.
  #
  # Clearing the channel first is the second half of the same discipline: with
  # no stale file to fall back on, a lane that fails to publish says so.
  Remove-Item $AutomationDir -Recurse -Force -ErrorAction SilentlyContinue
  $process = Start-Process $Executable -PassThru -WorkingDirectory $NativeDir -RedirectStandardError $RuntimeLog -RedirectStandardOutput $RuntimeOut

  # First-launch destination is already Files, so no chord is sent: pressing the
  # Files chord while on Files closes the destination (workbench.ts::navigate).
  Native-Click-Named $process.Id "adopt" 'role=button name="打开一个项目文件夹"'
  Native-Click-Named $process.Id "open-document" 'role=treeitem name="document\.md"'
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
  $conversionMode = Set-ImeChineseMode $window

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

  # Save is a command, not a button: the surface prints its chord on the menu
  # and the palette row, and `document.save` is the same W1 path both take. The
  # `name="Save"` button this looked for has not existed since the native
  # surface landed.
  $saveAttempt = Invoke-NativeAutomation @("shortcut", "document.save") (Join-Path $ResultRoot "save.automation.stderr.txt")
  if ($saveAttempt.ExitCode -ne 0 -or
      ($saveAttempt.Stderr.Length -gt 0 -and -not $saveAttempt.Stderr.StartsWith("delivered shortcut -> "))) {
    throw "Native Save action failed"
  }
  $punctuation | Out-Null
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
      # The observed IME_CMODE bitmask, not a wish: NATIVE (1) proves Chinese
      # mode was actually in force while these snapshots were taken.
      conversionMode = $conversionMode
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
