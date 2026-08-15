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
#     (no overlay up; a prelude below tunes a channel from the All list so
#     the tune scope is 'All' on every build, old or category-aware)
#   - RELEASE/Hermes build only -- debug numbers are void
#   - box otherwise idle (no install/download in progress)
#
# Scenarios: each begins from the fresh-process LANDING PANEL (Live's list
# overlay, TODOS scope, playing row focused -- identical on every build), one
# warm-up pass then the kept measured pass in the same process, with a
# uiautomator soft assertion -> stateOk CSV column on the list scenarios:
#   list_scroll 40x DOWN over the full-lineup list (measured)
#   rail_walk   LEFT into the rail, 20x UP to pin the top, 15x DOWN (measured)
#   panel_open  close panel, 5x (OK ... BACK) open/close (measured)
#   zap         close panel, 10x CHANNEL_UP in fullscreen (measured)
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
$KEY_DPAD_RIGHT = 22
$KEY_OK = 23
$KEY_CHANNEL_UP = 166

# Soft state assertion: dump the accessibility tree (uiautomator reaches RN
# views' text) and check a marker string is on screen. Never throws mid-run --
# a drifted scenario writes stateOk=false into its CSV row so the number is
# known-tainted instead of silently plausible.
function Test-UiContains {
  param([string] $Marker, [int] $Tries = 3)
  # uiautomator can race a busy render (video init, tune) and return a stale or
  # empty tree; retry before declaring the marker absent.
  for ($t = 0; $t -lt $Tries; $t++) {
    Invoke-Adb @("shell", "uiautomator", "dump", "/sdcard/ui.xml") | Out-Null
    $xml = Invoke-Adb @("shell", "cat", "/sdcard/ui.xml")
    if ((($xml | Out-String)) -match [regex]::Escape($Marker)) { return $true }
    Start-Sleep -Milliseconds 1500
  }
  return $false
}

# Close the browse panel if it is up, verifying it actually closed. Never
# presses BACK blind (fullscreen BACK exits to the Menu).
function Close-PanelIfOpen {
  if (Test-UiContains "CANALES" 2) {
    Send-Key $KEY_BACK
    Start-Sleep -Milliseconds 1500
    if (Test-UiContains "CANALES" 1) {
      Send-Key $KEY_BACK             # a drilled rail eats the first BACK
      Start-Sleep -Milliseconds 1500
    }
  }
}

# Deterministic reset to fullscreen Live, from ANY app state the previous
# scenario may have drifted into: kill the app and relaunch it. BACK-spam was
# tried first and overshoots (fullscreen BACK exits to the Menu by design, and
# the next BACK exits the app), so the only state that can be reached from
# EVERY drift is a fresh process. Costs ~40 s per pass; buys scenario numbers
# that cannot inherit a previous scenario's state. The Menu's first tile (TV
# EN VIVO) holds the opening focus, so one OK enters Live; with no remembered
# channel (fresh process) Live autoplays the hero fullscreen.
# Reset to the LANDING PANEL: a fresh process enters Live with the browse
# panel already open, scoped to TODOS/All with the playing row focused -- on
# every build, old or category-aware (verified by screenshot on both). That
# state IS the measurement surface: scenarios that need the full-lineup list
# start right here instead of trying to navigate a rail whose focus behavior
# the branch deliberately changed (the navigate-to-TODOS approach drifted on
# drilled reopens and was abandoned).
function Reset-ToLandingPanel {
  Invoke-Adb @("shell", "am", "force-stop", $script:Package) | Out-Null
  Start-Sleep -Seconds 2
  Invoke-Adb @("shell", "am", "start", "-n", "$($script:Package)/com.aliranclient.MainActivity") | Out-Null
  Start-Sleep -Seconds 25
  Send-Key $KEY_OK
  Start-Sleep -Seconds 10
}

# Each scenario is a pair of scriptblocks: Setup runs unmeasured to put the app
# in position, Measured is the gesture under test. Teardown restores fullscreen.
# AssertMarker (optional): a string that must be on screen right after Measured.
function Run-Scenario {
  param([string] $Name, [scriptblock] $Setup, [scriptblock] $Measured, [scriptblock] $Teardown, [string] $AssertMarker)
  $passes = 2
  if ($script:SkipWarmup) { $passes = 1 }
  $stats = $null
  $stateOk = $true
  # ONE reset per scenario, shared by both passes: a per-pass force-stop made
  # the measured pass as cold as the warm-up pass, so the numbers were mostly
  # process-start noise (JIT, empty EPG caches) instead of the gesture cost.
  Reset-ToLandingPanel
  for ($pass = 1; $pass -le $passes; $pass++) {
    & $Setup
    Reset-FrameStats
    & $Measured
    $stats = Read-FrameStats
    if ($AssertMarker) {
      $stateOk = Test-UiContains $AssertMarker
      if (-not $stateOk) { Write-Host "  WARN: '$Name' pass $pass drifted (marker '$AssertMarker' not on screen)" }
    }
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
    stateOk = $stateOk
  }
  $script:rows += $row
}

# --- connect (TCL adb auth quirk: a plain re-connect can answer "failed to
# authenticate" forever; the working recipe is a LOOPED disconnect -> connect,
# same as aliran-ops fsext-fixed/verify-on-device.ps1 Connect-Tv). adb writes
# routine complaints to stderr and PS 5.1 + ErrorActionPreference=Stop turns a
# redirected native stderr into a terminating NativeCommandError, so the adb
# legs run under a local Continue preference and never redirect stderr. ---
$connected = $false
for ($attempt = 1; $attempt -le 6; $attempt++) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & adb.exe disconnect $DeviceIp | Out-Null
    Start-Sleep -Seconds 2
    & adb.exe connect $DeviceIp | Out-Null
    Start-Sleep -Seconds 3
    $devices = & adb.exe devices
  } finally {
    $ErrorActionPreference = $prevEap
  }
  $hit = $devices | Select-String -SimpleMatch $DeviceIp | Select-String -SimpleMatch "device"
  if ($null -ne $hit) { $connected = $true; break }
  Write-Host "  connect attempt $attempt failed; retrying..."
}
if (-not $connected) { throw "Device $DeviceIp is not connected after 6 disconnect/connect rounds." }

# --- ensure the app is foreground (launch it if the box sits on the launcher) ---
function Get-FocusText {
  $focus = Invoke-Adb @("shell", "dumpsys", "window") | Select-String "mCurrentFocus|mFocusedApp" | Select-Object -First 2
  return (($focus | ForEach-Object { $_.ToString() }) -join " ")
}
if ((Get-FocusText) -notmatch [regex]::Escape($Package)) {
  Write-Host "  app not foreground; launching..."
  Invoke-Adb @("shell", "am", "start", "-n", "$Package/com.aliranclient.MainActivity") | Out-Null
  Start-Sleep -Seconds 25
  if ((Get-FocusText) -notmatch [regex]::Escape($Package)) {
    throw "Package $Package did not come to the foreground after launch."
  }
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }
$rows = @()

Write-Host "Measuring '$Label' on $DeviceIp / $Package ..."

# Every scenario starts from the fresh-process LANDING PANEL (TODOS scope,
# playing row focused -- identical on every build), so the measured gestures
# and the lists they sweep are build-neutral by construction:
#   list_scroll  pass 1 scrolls rows 1-40 of the full lineup, pass 2 rows
#                41-80 (the panel stays open between passes) -- both passes
#                sweep the full TODOS list on both builds
#   rail_walk    LEFT into the rail near its top, UP x20 to pin the start,
#                DOWN x15 over the categories
#   panel_open   closes the landing panel, then 5x (OK ... BACK); on the
#                category-aware build OK reopens DRILLED into the playing
#                channel's rail -- same machinery, slightly different content;
#                the target for this scenario is "no regression"
#   zap          closes the panel, 10x CHANNEL_UP; the category-aware build
#                rings the hero's category -- same tune pipeline per press

Run-Scenario -Name "list_scroll" -Setup {
  Start-Sleep -Milliseconds 500       # the landing panel is already open, playing row focused
} -Measured {
  Send-KeyBurst $KEY_DPAD_DOWN 40 150
} -Teardown {
  Start-Sleep -Milliseconds 300
} -AssertMarker "CANALES"

Run-Scenario -Name "rail_walk" -Setup {
  Send-Key $KEY_DPAD_LEFT             # from the focused playing row into the rail (lands near the top)
  Start-Sleep -Milliseconds 600
  Send-KeyBurst $KEY_DPAD_UP 20 150   # pin the start at the top of the rail
  Start-Sleep -Milliseconds 700
} -Measured {
  Send-KeyBurst $KEY_DPAD_DOWN 15 150
} -Teardown {
  Start-Sleep -Milliseconds 300
} -AssertMarker "CANALES"

Run-Scenario -Name "panel_open" -Setup {
  Close-PanelIfOpen                   # pass 1 closes the landing panel; pass 2 no-op
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

# LAST in the list: zapping moves the playing channel; the per-scenario reset
# makes ordering less critical, but the channel it leaves behind becomes the
# resumed channel for any later manual poking, so keep it last anyway.
Run-Scenario -Name "zap" -Setup {
  Close-PanelIfOpen
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
