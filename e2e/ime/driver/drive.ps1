# IME acceptance driver. Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File drive.ps1 -Shell e42
# Phases: first-click focus + first word / 60s pinyin burst / punctuation x10 each.
# Marks: F13/F14/F15 phase begins, F16 end. Full-screen PNGs into results\<shell>\.
param(
  [Parameter(Mandatory=$true)][ValidateSet('e42','e43','e44','wv2')][string]$Shell,
  [string]$Root = (Resolve-Path "$PSScriptRoot\..").Path,
  [int]$BurstSeconds = 60
)

$ErrorActionPreference = 'Stop'
$outDir = Join-Path $Root "results\$Shell"
New-Item -ItemType Directory -Force $outDir | Out-Null
Remove-Item "$outDir\*.flag","$outDir\*.json","$outDir\*.png" -Force -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Tap([int]$vk, [int]$holdMs = 30) {
  [Win]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $holdMs
  [Win]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
}
function Type-Letters([string]$s, [int]$gapMs = 90) {
  foreach ($c in $s.ToCharArray()) {
    Tap ([int][char]::ToUpper($c)) 25
    Start-Sleep -Milliseconds $gapMs
  }
}
function Shoot([string]$name) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $outDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "[shot] $name"
}

# --- make MS Pinyin the default input method for processes started from now on
$tip = '0804:{81D4E9C9-1D3B-41BC-9E6C-4B40BF79E35E}{FA550B04-5AD7-411F-A5AC-CA038EC515D7}'
Set-WinDefaultInputMethodOverride -InputTip $tip
Write-Host "[ime] default override -> MS Pinyin"

# --- launch shell
$proc = $null
if ($Shell -eq 'wv2') {
  $proc = Start-Process powershell -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$Root\shells\wv2\host.ps1",'-Shell',$Shell,'-Root',$Root
} else {
  $exe = "$Root\shells\$Shell\node_modules\electron\dist\electron.exe"
  $proc = Start-Process $exe -PassThru -ArgumentList "`"$Root\shells\$Shell\main.js`"",$Shell
}
Write-Host "[launch] $Shell pid=$($proc.Id)"

# --- wait ready
$deadline = (Get-Date).AddSeconds(60)
while (-not (Test-Path "$outDir\ready.flag")) {
  if ((Get-Date) -gt $deadline) { throw "ready.flag timeout for $Shell" }
  Start-Sleep -Milliseconds 500
}
Start-Sleep -Seconds 2
Write-Host "[ready] page instrumented"

# --- find window
$hwnd = [IntPtr]::Zero
foreach ($p in (Get-Process | Where-Object { $_.MainWindowTitle -like 'IME-TEST*' })) { $hwnd = $p.MainWindowHandle; break }
if ($hwnd -eq [IntPtr]::Zero) { throw "window IME-TEST* not found" }
[Win]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
[Win]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 800
$r = New-Object Win+RECT
[Win]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$cx = [int](($r.Left + $r.Right) / 2); $cy = [int](($r.Top + $r.Bottom) / 2)
[Win]::SetCursorPos($cx, $cy) | Out-Null
[Win]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
[Win]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
Write-Host "[click] center $cx,$cy"

# --- activate MS Pinyin in the test window (probe + toggle loop)
function Test-CompositionFlowing {
  Start-Sleep -Milliseconds 1400
  if (-not (Test-Path "$outDir\latest.json")) { return $false }
  $j = Get-Content "$outDir\latest.json" -Raw | ConvertFrom-Json
  return ((@($j.events | Where-Object { $_.type -eq 'compositionstart' })).Count -gt 0)
}
$imeOn = $false
$toggles = @('shift', 'ctrlspace', 'winspace', 'shift')
foreach ($attempt in 1..4) {
  Type-Letters 'q' 40            # probe: starts a pinyin composition if IME is live
  if (Test-CompositionFlowing) { $imeOn = $true; break }
  Tap 0x08 30                    # Backspace: remove stray probe char
  switch ($toggles[$attempt - 1]) {
    'shift'     { Tap 0x10 60 }  # Shift: Pinyin CN/EN mode toggle (most common cause)
    'ctrlspace' { [Win]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); Tap 0x20 40; [Win]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero) }
    'winspace'  { [Win]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero); Tap 0x20 40; [Win]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero) }
  }
  Start-Sleep -Milliseconds 900
}
if ($imeOn) { Tap 0x1B 60; Write-Host "[ime] MS Pinyin flowing (attempt loop ok)" }
else { throw "IME did not activate in test window" }

Start-Sleep -Milliseconds 1200
Shoot '01-first-click.png'

# --- phase 1: first word after first click
Tap 0x7C  # F13
Start-Sleep -Milliseconds 300
Type-Letters 'ni' 200
Shoot '02-first-composition.png'   # candidate window should be visible here
Type-Letters 'hao' 150
Tap 0x20 60                        # space -> commit
Start-Sleep -Milliseconds 800
Shoot '03-first-word.png'
Write-Host "[phase1] first word done"

# guard: verify keystrokes actually reached the page before wasting 90 more seconds
Start-Sleep -Milliseconds 1500
try {
  $chk = Get-Content "$outDir\latest.json" -Raw | ConvertFrom-Json
  if ($chk.events.Count -eq 0) { throw "no events captured after phase1 (window not focused / input lost)" }
  Write-Host "[guard] events flowing: $($chk.events.Count)"
} catch { throw }

# --- phase 2: 60s continuous pinyin
Tap 0x7D  # F14
$words = @('nihao','women','dajia','zhongguo','xuesheng','gongzuo','xuexi','diannao','shurufa','ceshi','wenzhang','bianjiqi','shijie','pengyou','xihuan','yinyue','dianying','tianqi','mingtian','xiexie')
$t0 = Get-Date
$i = 0
$shots = @(15, 35, 55)
while (((Get-Date) - $t0).TotalSeconds -lt $BurstSeconds) {
  Type-Letters $words[$i % $words.Count] 70
  Tap 0x20 40
  Start-Sleep -Milliseconds 250
  $el = [int]((Get-Date) - $t0).TotalSeconds
  if ($shots -contains $el) { Shoot ("04-burst-{0:d2}s.png" -f $el); $shots = $shots | Where-Object { $_ -ne $el } }
  $i++
}
Write-Host "[phase2] burst done, words sent=$i"
Shoot '05-burst-end.png'

# --- phase 3: punctuation, 10x each: , . ? !
Tap 0x7E  # F15
Start-Sleep -Milliseconds 400
foreach ($round in 1..10) {
  foreach ($p in @(@(0xBC,$false), @(0xBE,$false), @(0xBF,$true), @(0x31,$true))) {
    if ($p[1]) { [Win]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero) }
    Tap ([int]$p[0]) 30
    if ($p[1]) { [Win]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 600
  }
  if ($round -eq 5) { Shoot '06-punct-mid.png' }
}
Write-Host "[phase3] punctuation done"
Shoot '07-punct-end.png'

Tap 0x7F  # F16 end mark
Start-Sleep -Seconds 3
Shoot '08-final.png'

# --- collect + teardown
if (Test-Path "$outDir\latest.json") { Copy-Item "$outDir\latest.json" "$outDir\final.json" -Force }
Write-Host "[done] final.json copied"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
if ($Shell -eq 'wv2') {
  Get-Process msedgewebview2 -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$($outDir.Replace('\','\\'))*" -or $_.CommandLine -like "*wv2ud*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}
Write-Host "[exit] $Shell run complete"
