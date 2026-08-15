# tv-perf-measure.ps1 -- repeatable TV-client frame-time measurement over adb.
#
# Measures the four browse gestures that the snappiness work targets, using
# Android's own aggregate frame stats (dumpsys gfxinfo <pkg> reset ... dump).
# Run it BEFORE a change (label "baseline") and again on the finished build with
# another label; every run appends one CSV row per scenario, so the comparison
# is a filter on the label column.
#
# PREREQUISITES (the script checks the first two):
#   - the box is reachable over adb (TCL sets need disconnect-then-connect)
#   - the app is FOREGROUND, in fullscreen Live playback, freshly launched
#     (hero channel playing, no overlay up, category scope still "All")
#   - RELEASE/Hermes build only -- debug numbers are void
#   - box otherwise idle (no install/download in progress)
#
# Scenarios (each does a warm-up pass first and keeps the second pass):
#   rail_walk   OK, LEFT into the category rail, 15x DOWN (measured),
#               then 15x UP to restore the "All" scope, BACK to fullscreen
#   list_scroll OK to open the channel list on the playing row, 40x DOWN
#               (measured), BACK to fullscreen
#   panel_open  5x (OK ... BACK) open/close of the browse panel (measured)
#   zap         10x CHANNEL_UP in fullscreen (measured; runs LAST -- it moves
#               the playing channel and, after the scoped-zap change, the scope)
#
# Windows PowerShell 5.1, pure ASCII. No && / ternary anywhere.

param(
  [Parameter(Mandatory = $true)] [string] $Label,
  [string] $DeviceIp = "192.168.1.128:5555",
  [string] $Package = "com.aliranclient.soltv",
  [string] $OutDir = "C:\Users\EESTQ\claude\aliran-ops\perf",
  [string] $ApkCommit = "",
  [switch] $SkipWarmup
)

$ErrorActionPreference = "Stop"
$csvPath = Join-Path $OutDir "perf-results.csv"

function Invoke-Adb {
  param([string[]] $ArgList)
  $out = & adb.exe -s $script:DeviceIp @ArgList
  return $out
}

# One shell invocation per burst: per-keyevent adb round-trips add 100-300 ms of
# host-side jitter, which would swamp the thing being measured. The on-device
# loop paces keys at a fixed cadence like a held remote button.
function Send-KeyBurst {
  param([int] $KeyCode, [int] $Count, [int] $DelayMs)
  $sec = [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, "{0:0.###}", ($DelayMs / 1000.0))
  $cmd = "for i in `$(seq 1 $Count); do input keyevent $KeyCode; sleep $sec; done"
  Invoke-Adb @("shell", $cmd) | Out-Null
}

function Send-Key {
  param([int] $KeyCode)
  Invoke-Adb @("shell", "input", "keyevent", "$KeyCode") | Out-Null
}

function Reset-FrameStats {
  Invoke-Adb @("shell", "dumpsys", "gfxinfo", $script:Package, "reset") | Out-Null
  Start-Sleep -Milliseconds 500
}

function Read-FrameStats {
  # Aggregate stats since the last reset. Percentile lines look like
  # "90th percentile: 23ms"; janky line like "Janky frames: 12 (8.51%)".
  Start-Sleep -Milliseconds 800
  $dump = Invoke-Adb @("shell", "dumpsys", "gfxinfo", $script:Package)
  $stats = @{ total = ""; janky = ""; jankyPct = ""; p50 = ""; p90 = ""; p95 = ""; p99 = "" }
  foreach ($line in $dump) {
    if ($line -match "Total frames rendered:\s*(\d+)") { $stats.total = $Matches[1] }
    elseif ($line -match "Janky frames:\s*(\d+)\s*\(([\d.]+)%\)") { $stats.janky = $Matches[1]; $stats.jankyPct = $Matches[2] }
    elseif ($line -match "50th percentile:\s*(\d+)ms") { $stats.p50 = $Matches[1] }
    elseif ($line -match "90th percentile:\s*(\d+)ms") { $stats.p90 = $Matches[1] }
    elseif ($line -match "95th percentile:\s*(\d+)ms") { $stats.p95 = $Matches[1] }
    elseif ($line -match "99th percentile:\s*(\d+)ms") { $stats.p99 = $Matches[1] }
  }
  return $stats
}

# Key codes
$KEY_BACK = 4
$KEY_DPAD_UP = 19
$KEY_DPAD_DOWN = 20
$KEY_DPAD_LEFT = 21
$KEY_OK = 23
$KEY_CHANNEL_UP = 166

# Each scenario is a pair of scriptblocks: Setup runs unmeasured to put the app
# in position, Measured is the gesture under test. Teardown restores fullscreen.
function Run-Scenario {
  param([string] $Name, [scriptblock] $Setup, [scriptblock] $Measured, [scriptblock] $Teardown)
  $passes = 2
  if ($script:SkipWarmup) { $passes = 1 }
  $stats = $null
  for ($pass = 1; $pass -le $passes; $pass++) {
    & $Setup
    Reset-FrameStats
    & $Measured
    $stats = Read-FrameStats
    & $Teardown
    Start-Sleep -Milliseconds 1000
  }
  Write-Host ("  {0,-12} frames={1,-5} janky={2} ({3}%)  p50={4}ms p90={5}ms p95={6}ms p99={7}ms" -f `
    $Name, $stats.total, $stats.janky, $stats.jankyPct, $stats.p50, $stats.p90, $stats.p95, $stats.p99)
  $row = [pscustomobject]@{
    timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    label = $script:Label
    apkCommit = $script:ApkCommit
    device = $script:DeviceIp
    package = $script:Package
    scenario = $Name
    totalFrames = $stats.total
    jankyFrames = $stats.janky
    jankyPct = $stats.jankyPct
    p50ms = $stats.p50
    p90ms = $stats.p90
    p95ms = $stats.p95
    p99ms = $stats.p99
  }
  $script:rows += $row
}

# --- connect (TCL adb auth quirk: disconnect first, then connect) ---
& adb.exe disconnect $DeviceIp 2>$null | Out-Null
& adb.exe connect $DeviceIp | Out-Null
$devices = & adb.exe devices
$hit = $devices | Select-String -SimpleMatch $DeviceIp | Select-String -SimpleMatch "device"
if ($null -eq $hit) { throw "Device $DeviceIp is not connected (adb devices shows no 'device' state for it)." }

# --- verify the app is foreground ---
$focus = Invoke-Adb @("shell", "dumpsys", "window") | Select-String "mCurrentFocus|mFocusedApp" | Select-Object -First 2
$focusText = ($focus | ForEach-Object { $_.ToString() }) -join " "
if ($focusText -notmatch [regex]::Escape($Package)) {
  throw "Package $Package is not foreground (focus: $focusText). Launch the app into fullscreen Live playback first."
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }
$rows = @()

Write-Host "Measuring '$Label' on $DeviceIp / $Package ..."

Run-Scenario -Name "list_scroll" -Setup {
  Send-Key $KEY_OK            # open the browse panel on the playing row
  Start-Sleep -Milliseconds 1200
} -Measured {
  Send-KeyBurst $KEY_DPAD_DOWN 40 150
} -Teardown {
  Send-Key $KEY_BACK          # list -> fullscreen
  Start-Sleep -Milliseconds 800
}

Run-Scenario -Name "rail_walk" -Setup {
  Send-Key $KEY_OK            # open the browse panel
  Start-Sleep -Milliseconds 1200
  Send-Key $KEY_DPAD_LEFT     # focus into the category rail
  Start-Sleep -Milliseconds 600
} -Measured {
  Send-KeyBurst $KEY_DPAD_DOWN 15 150
} -Teardown {
  Send-KeyBurst $KEY_DPAD_UP 15 150   # walk back up: restore the "All" scope
  Start-Sleep -Milliseconds 400
  Send-Key $KEY_BACK          # list -> fullscreen
  Start-Sleep -Milliseconds 800
}

Run-Scenario -Name "panel_open" -Setup {
  Start-Sleep -Milliseconds 200
} -Measured {
  for ($i = 0; $i -lt 5; $i++) {
    Send-Key $KEY_OK
    Start-Sleep -Milliseconds 900
    Send-Key $KEY_BACK
    Start-Sleep -Milliseconds 700
  }
} -Teardown {
  Start-Sleep -Milliseconds 200
}

# LAST: zapping moves the playing channel (and the tune scope, once scoped zap
# lands), so nothing may run after it in the same invocation.
Run-Scenario -Name "zap" -Setup {
  Start-Sleep -Milliseconds 200
} -Measured {
  Send-KeyBurst $KEY_CHANNEL_UP 10 1500
} -Teardown {
  Start-Sleep -Milliseconds 500
}

# --- append CSV ---
$writeHeader = -not (Test-Path $csvPath)
if ($writeHeader) {
  $rows | Export-Csv -Path $csvPath -NoTypeInformation -Encoding ASCII
} else {
  $existing = Import-Csv $csvPath
  $all = @($existing) + @($rows)
  $all | Export-Csv -Path $csvPath -NoTypeInformation -Encoding ASCII
}
Write-Host "Appended $($rows.Count) rows to $csvPath"
