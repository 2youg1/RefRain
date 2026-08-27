# Copyright (c) 2026 2youg1
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

param(
  [string]$Root = "",
  [string]$Binary = "apps/native/zig-out/bin/refrain.exe"
)

# 真输入通道（Windows）。
#
# 八条 journal 走的是 automation：`widget-click` 按 id 点、`set_text` 直接置换
# 文本、`shortcut` 按命令 id 触发。它们测的是 core 状态机与可访问性树,输入层
# 一寸都不覆盖——键位表配错、和弦被别人抢走、点击落在被遮住的部件上,journal
# 全绿。这条通道只用 OS 级输入:keybd_event 与 mouse_event,坐标从可访问性树报
# 的 bounds 算出来,和弦从 app.zon 读出来。
#
# 与 e2e/ime 的分工:那条要 zh-Hans-CN 输入法才能跑,于是「真输入」这件事一直被
# 输入法的安装与否挡着。这条不碰输入法,只按 ASCII 与和弦,有桌面就能跑。

$ErrorActionPreference = "Stop"
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
$Root = (Resolve-Path $Root).Path
$Executable = (Resolve-Path (Join-Path $Root $Binary)).Path
$NativeDir = Join-Path $Root "apps/native"
$NativeCli = Join-Path $NativeDir "node_modules/.bin/native.exe"
$AutomationDir = Join-Path $NativeDir ".zig-cache/native-sdk-automation"
$RelativeResultRoot = "e2e/native-input/results/windows"
$ResultRoot = Join-Path $Root $RelativeResultRoot
$FixtureRoot = Join-Path $ResultRoot "fixture"
$DocumentPath = Join-Path $FixtureRoot "document.md"
$ManifestPath = Join-Path $ResultRoot "run.json"

Remove-Item $ResultRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item $FixtureRoot -ItemType Directory -Force | Out-Null
$OriginalText = "第一行`n`n第二行"
[IO.File]::WriteAllText($DocumentPath, $OriginalText, [Text.UTF8Encoding]::new($false))

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RealInput {
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool enable);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public struct POINT { public int X; public int Y; }
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

# 和弦表从 app.zon 读,一个键位都不在这个脚本里复述。
$ChordJson = & bun (Join-Path $Root "e2e/native-input/chords.ts")
if ($LASTEXITCODE -ne 0) { throw "chord table refused: $ChordJson" }
$Chords = @{}
foreach ($chord in ($ChordJson | ConvertFrom-Json)) { $Chords[$chord.id] = $chord }

function Tap([int]$Key, [int]$HoldMs = 40) {
  [RealInput]::keybd_event([byte]$Key, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $HoldMs
  [RealInput]::keybd_event([byte]$Key, 0, 2, [UIntPtr]::Zero)
}

<#
  按下 app.zon 里那一条和弦——真的按,修饰符先下后起。

  这是这条通道存在的理由:`native automate shortcut document.save` 把命令直接送
  进 runtime,而这里送的是 Ctrl 与 S 两个键,由 OS 与 SDK 自己去认那是不是
  document.save。表里写错一个键,这里红,那里绿。
#>
function Press-Chord([string]$Id) {
  $chord = $Chords[$Id]
  if ($null -eq $chord) { throw "app.zon declares no shortcut $Id" }
  foreach ($modifier in $chord.windows.modifierCodes) {
    [RealInput]::keybd_event([byte]$modifier, 0, 0, [UIntPtr]::Zero)
  }
  Start-Sleep -Milliseconds 30
  Tap ([int]$chord.windows.keyCode)
  Start-Sleep -Milliseconds 30
  $reversed = @($chord.windows.modifierCodes)
  [array]::Reverse($reversed)
  foreach ($modifier in $reversed) {
    [RealInput]::keybd_event([byte]$modifier, 0, 2, [UIntPtr]::Zero)
  }
  Start-Sleep -Milliseconds 250
}

function Type-Ascii([string]$Value, [int]$GapMs = 60) {
  foreach ($character in $Value.ToCharArray()) {
    $upper = [char]::ToUpper($character)
    $needsShift = [char]::IsUpper($character)
    if ($needsShift) { [RealInput]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero) }
    Tap ([int]$upper) 30
    if ($needsShift) { [RealInput]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds $GapMs
  }
}

function Force-Foreground([IntPtr]$Window) {
  $unusedPid = [uint32]0
  $foreground = [RealInput]::GetForegroundWindow()
  $foregroundThread = [RealInput]::GetWindowThreadProcessId($foreground, [ref]$unusedPid)
  $targetThread = [RealInput]::GetWindowThreadProcessId($Window, [ref]$unusedPid)
  $currentThread = [RealInput]::GetCurrentThreadId()
  [RealInput]::AttachThreadInput($currentThread, $targetThread, $true) | Out-Null
  [RealInput]::AttachThreadInput($foregroundThread, $targetThread, $true) | Out-Null
  [RealInput]::SetForegroundWindow($Window) | Out-Null
  [RealInput]::AttachThreadInput($currentThread, $targetThread, $false) | Out-Null
  [RealInput]::AttachThreadInput($foregroundThread, $targetThread, $false) | Out-Null
}

function Snapshot([int]$PublisherPid, [string]$Name, [string]$Required = "") {
  $deadline = (Get-Date).AddSeconds(30)
  $seen = ""
  do {
    Start-Process $NativeCli -ArgumentList @("automate", "snapshot") -WorkingDirectory $NativeDir `
      -NoNewWindow -Wait -RedirectStandardOutput (Join-Path $ResultRoot "s.out") `
      -RedirectStandardError (Join-Path $ResultRoot "s.err") | Out-Null
    $delivered = Join-Path $AutomationDir "snapshot.txt"
    if (Test-Path $delivered) {
      $seen = [IO.File]::ReadAllText($delivered, [Text.UTF8Encoding]::new($false))
    }
    if ($seen -match "ready=true" -and $seen -match "publisher_pid=$PublisherPid(\s|$)" -and
        $seen -match "dispatch_errors=0" -and $seen -match "gpu_nonblank=true" -and
        ($Required.Length -eq 0 -or $seen -match $Required)) {
      [IO.File]::WriteAllText((Join-Path $ResultRoot "$Name.snapshot.txt"), "$seen`n", [Text.UTF8Encoding]::new($false))
      return $seen
    }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $deadline)
  [IO.File]::WriteAllText((Join-Path $ResultRoot "$Name.unmatched.txt"), "$seen`n", [Text.UTF8Encoding]::new($false))
  throw "snapshot $Name never showed /$Required/ (saw $RelativeResultRoot/$Name.unmatched.txt)"
}

<#
  真点击一个可访问性树报得出的部件。

  坐标来自树自己报的 bounds,点的是它的中心。这一步同时验的是命中测试:如果
  部件被别的面盖住,或者树报的 bounds 与实际绘制的位置对不上,点就落空,而
  `widget-click` 永远落不空——它根本不经过坐标。
#>
function Click-Widget([IntPtr]$Window, [string]$Snapshot, [string]$Pattern, [string]$What) {
  $found = [regex]::Match($Snapshot, "$Pattern bounds=\(([-0-9.]+),([-0-9.]+) ([0-9.]+)x([0-9.]+)\)")
  if (-not $found.Success) { throw "no widget matching $Pattern to click for $What" }
  $x = [int]([double]$found.Groups[1].Value + [double]$found.Groups[3].Value / 2)
  $y = [int]([double]$found.Groups[2].Value + [double]$found.Groups[4].Value / 2)
  Click-Point $Window $x $y
  return @{ x = $x; y = $y }
}

function Click-Point([IntPtr]$Window, [int]$X, [int]$Y) {
  $point = New-Object RealInput+POINT
  $point.X = $X
  $point.Y = $Y
  if (-not [RealInput]::ClientToScreen($Window, [ref]$point)) { throw "ClientToScreen failed" }
  [RealInput]::SetCursorPos($point.X, $point.Y) | Out-Null
  Start-Sleep -Milliseconds 60
  [RealInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [RealInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 350
}

# 只截窗口客户区,不截整屏:判据要问的是「这个应用画了什么」,桌面的像素混进来
# 只会让一条问错的判据看起来通过。
function Capture-Client([IntPtr]$Window, [string]$Name) {
  $rect = New-Object RealInput+RECT
  if (-not [RealInput]::GetClientRect($Window, [ref]$rect)) { throw "GetClientRect failed" }
  $origin = New-Object RealInput+POINT
  $origin.X = 0
  $origin.Y = 0
  [RealInput]::ClientToScreen($Window, [ref]$origin) | Out-Null
  $bitmap = New-Object System.Drawing.Bitmap $rect.Right, $rect.Bottom
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $path = Join-Path $ResultRoot "$Name.png"
  try {
    $graphics.CopyFromScreen($origin.X, $origin.Y, 0, 0, $bitmap.Size)
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return "$RelativeResultRoot/$Name.png"
}

$env:REFRAIN_AUTOMATION_ROOT = $FixtureRoot
$env:REFRAIN_DATA_DIR = (Join-Path $ResultRoot "appdata")
Remove-Item $AutomationDir -Recurse -Force -ErrorAction SilentlyContinue

Push-Location $Root
$process = $null
try {
  $process = Start-Process $Executable -PassThru -WorkingDirectory $NativeDir `
    -RedirectStandardError (Join-Path $ResultRoot "runtime.stderr.log") `
    -RedirectStandardOutput (Join-Path $ResultRoot "runtime.stdout.log")

  $launched = Snapshot $process.Id "launched" 'role=button name="打开一个项目文件夹"'

  $window = [IntPtr]::Zero
  $deadline = (Get-Date).AddSeconds(20)
  while ($window -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
    $window = (Get-Process -Id $process.Id).MainWindowHandle
    Start-Sleep -Milliseconds 100
  }
  if ($window -eq [IntPtr]::Zero) { throw "the runtime never opened a main window" }
  if ((Get-Process -Id $process.Id).MainWindowTitle -ne "RefRain") { throw "not the RefRain window" }
  [RealInput]::ShowWindow($window, 9) | Out-Null
  Force-Foreground $window
  Start-Sleep -Milliseconds 400

  # 一、真点击采纳项目目录。
  $adoptAt = Click-Widget $window $launched 'role=button name="打开一个项目文件夹"' "adopt"
  $adopted = Snapshot $process.Id "adopted" 'role=treeitem name="document\.md"'

  # 二、真点击打开文档。
  $openAt = Click-Widget $window $adopted 'role=treeitem name="document\.md"' "open"
  $opened = Snapshot $process.Id "opened" 'role=textbox name="RefRain manuscript"'
  $openedShot = Capture-Client $window "opened"

  # 三、真点击落进正稿,再用真按键打字。ASCII 不经输入法,所以这一步不需要装
  # 任何语言包——真输入这件事因此不再被输入法挡着。
  $editorBounds = [regex]::Match($opened, 'role=textbox name="RefRain manuscript" bounds=\(([-0-9.]+),([-0-9.]+) ([0-9.]+)x([0-9.]+)\)')
  if (-not $editorBounds.Success) { throw "the snapshot reports no manuscript bounds" }
  $editorX = [int][double]$editorBounds.Groups[1].Value
  $editorY = [int][double]$editorBounds.Groups[2].Value
  Click-Point $window ($editorX + 60) ($editorY + 24)
  $focused = Snapshot $process.Id "focused" 'role=textbox name="RefRain manuscript".*focused=true'

  $typed = "Refrain"
  Type-Ascii $typed
  Start-Sleep -Milliseconds 400
  $afterTyping = Snapshot $process.Id "typed"
  $typedShot = Capture-Client $window "typed"

  # 四、真和弦保存。文件落盘与否是这一步唯一的证据。
  Press-Chord "document.save"
  Start-Sleep -Milliseconds 700
  $savedBytes = [IO.File]::ReadAllText($DocumentPath, [Text.UTF8Encoding]::new($false))
  $afterSave = Snapshot $process.Id "saved"

  # 五、真和弦撤销。
  Press-Chord "document.undo"
  Start-Sleep -Milliseconds 500
  $afterUndo = Snapshot $process.Id "undone"

  # 六、真和弦换主题——这一条的证据是像素:纸色必须真的变了。
  $beforeThemeShot = Capture-Client $window "theme-before"
  Press-Chord "theme.next"
  Start-Sleep -Milliseconds 900
  $afterThemeShot = Capture-Client $window "theme-after"
  $afterTheme = Snapshot $process.Id "theme"

  # 七、真和弦换去处。
  Press-Chord "go.2"
  Start-Sleep -Milliseconds 600
  $afterGo = Snapshot $process.Id "destination"
  $destinationShot = Capture-Client $window "destination"

  # 八、真和弦退出:干净出口本身就是 app.quit 的判据。
  Press-Chord "app.quit"
  $exited = $process.WaitForExit(15000)
  # 退出码得先取下来再放进清单：在哈希表字面里取 `$process.ExitCode`
  # 会序列化成 null，而 null 与「退出码不是 0」在证据里是两件事。
  $exitCode = -1
  if ($exited) {
    $process.Refresh()
    $exitCode = [int]$process.ExitCode
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    platform      = "windows"
    processId     = $process.Id
    executable    = (Resolve-Path -Relative $Executable)
    documentPath  = "$RelativeResultRoot/fixture/document.md"
    input         = [ordered]@{
      source        = "os"
      clicks        = @(
        [ordered]@{ what = "adopt"; client = $adoptAt }
        [ordered]@{ what = "open";  client = $openAt }
      )
      typedText     = $typed
      chordsPressed = @("document.save", "document.undo", "theme.next", "go.2", "app.quit")
    }
    observed      = [ordered]@{
      savedText      = $savedBytes
      originalText   = $OriginalText
      exitedOnChord  = $exited
      exitCode       = $exitCode
    }
    # 正稿区的位置由可访问性树自己报，不由判据猜比例。猜比例的那一版把
    # 取样区放在了字的下方，测出 0% 的墨——判据错得像缺陷。
    manuscript    = [ordered]@{
      x      = $editorX
      y      = $editorY
      width  = [int][double]$editorBounds.Groups[3].Value
      height = [int][double]$editorBounds.Groups[4].Value
    }
    snapshots     = [ordered]@{
      launched    = "$RelativeResultRoot/launched.snapshot.txt"
      adopted     = "$RelativeResultRoot/adopted.snapshot.txt"
      opened      = "$RelativeResultRoot/opened.snapshot.txt"
      focused     = "$RelativeResultRoot/focused.snapshot.txt"
      typed       = "$RelativeResultRoot/typed.snapshot.txt"
      saved       = "$RelativeResultRoot/saved.snapshot.txt"
      undone      = "$RelativeResultRoot/undone.snapshot.txt"
      theme       = "$RelativeResultRoot/theme.snapshot.txt"
      destination = "$RelativeResultRoot/destination.snapshot.txt"
    }
    screenshots   = [ordered]@{
      opened      = $openedShot
      typed       = $typedShot
      themeBefore = $beforeThemeShot
      themeAfter  = $afterThemeShot
      destination = $destinationShot
    }
  }
  $afterTyping | Out-Null
  $afterSave | Out-Null
  $afterUndo | Out-Null
  $afterTheme | Out-Null
  $afterGo | Out-Null
  $focused | Out-Null
  [IO.File]::WriteAllText($ManifestPath, "$($manifest | ConvertTo-Json -Depth 8)`n", [Text.UTF8Encoding]::new($false))

  & bun (Join-Path $Root "e2e/native-input/assert.ts") --root $Root --manifest "$RelativeResultRoot/run.json"
  if ($LASTEXITCODE -ne 0) { throw "real-input evidence failed" }
} finally {
  if ($null -ne $process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Pop-Location
}
