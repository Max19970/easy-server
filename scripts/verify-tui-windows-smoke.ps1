param(
  [Parameter(Mandatory = $true)]
  [string]$Program,

  [string[]]$ProgramArgs = @(),

  [string]$ProgramArgsJson = "",

  [ValidateSet("quit", "ctrl-c", "error")]
  [string]$ExitMode = "quit",

  [int]$Columns = 120,
  [int]$Rows = 40,

  [switch]$ResizeToNarrow,
  [switch]$NoColor,
  [switch]$ScreenReader,
  [switch]$Relaunch,
  [string]$ExpectedText = "EasyServer"
)

$ErrorActionPreference = "Stop"

if ($ProgramArgsJson.Length -gt 0) {
  $ProgramArgs = @(ConvertFrom-Json -InputObject $ProgramArgsJson)
}

if ($env:OS -ne "Windows_NT") {
  throw "TUI Windows smoke requires Windows."
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EasyServerTuiSmokeNative {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);

  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@

$mintty = Join-Path $env:ProgramFiles "Git\usr\bin\mintty.exe"
if (-not (Test-Path -LiteralPath $mintty)) {
  throw "Git for Windows mintty.exe is required for the Windows TUI smoke."
}

$title = "EasyServerTuiSmoke-$PID-$([Guid]::NewGuid().ToString('N'))"
$log = Join-Path $env:TEMP "$title.log"
$state = Join-Path $env:TEMP "$title-state.json"
$daemon = Join-Path $env:TEMP "$title-daemon.json"
$runner = Join-Path $env:TEMP "$title-runner.mjs"
$relaunchMarker = "__EASYSERVER_SECOND_LAUNCH__"
Remove-Item -LiteralPath $log, $state, $daemon, $runner -Force -ErrorAction SilentlyContinue

$previousState = $env:EASYSERVER_STATE_FILE
$previousDaemon = $env:EASYSERVER_DAEMON_FILE
$previousNoColor = $env:NO_COLOR
$previousScreenReader = $env:INK_SCREEN_READER
$previousMsysArgConversion = $env:MSYS2_ARG_CONV_EXCL
$env:EASYSERVER_STATE_FILE = $state
$env:EASYSERVER_DAEMON_FILE = $daemon
if ($NoColor) {
  $env:NO_COLOR = "1"
}
else {
  Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue
}
if ($ScreenReader) {
  $env:INK_SCREEN_READER = "true"
}
else {
  Remove-Item Env:INK_SCREEN_READER -ErrorAction SilentlyContinue
}
$env:MSYS2_ARG_CONV_EXCL = "*"

function Quote-MinttyArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Find-SmokeWindow([DateTime]$Deadline) {
  do {
    $processInfo = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -eq "mintty.exe" -and $_.CommandLine -like "*$title*"
      } |
      Select-Object -First 1
    if ($null -ne $processInfo) {
      $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
      if ($null -ne $process -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
        return $process
      }
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $Deadline)
  return $null
}

function Wait-ForExit([int]$ProcessId, [DateTime]$Deadline) {
  do {
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
      return $true
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $Deadline)
  return $false
}

function Read-SharedText([string]$Path) {
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::ReadWrite
  )
  try {
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
    return $reader.ReadToEnd()
  }
  finally {
    $stream.Dispose()
  }
}

function Wait-ForLogText([string]$Path, [string]$Needle, [DateTime]$Deadline) {
  do {
    if (Test-Path -LiteralPath $Path) {
      try {
        if ((Read-SharedText $Path).Contains($Needle)) {
          return $true
        }
      }
      catch [IO.IOException] {
        # mintty may still be creating or rotating the log; retry until deadline.
      }
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $Deadline)
  return $false
}

function Wait-ForLogTextAfter([string]$Path, [string]$Marker, [string]$Needle, [DateTime]$Deadline) {
  do {
    if (Test-Path -LiteralPath $Path) {
      try {
        $text = Read-SharedText $Path
        $markerIndex = $text.LastIndexOf($Marker)
        if ($markerIndex -ge 0 -and $text.IndexOf($Needle, $markerIndex + $Marker.Length) -ge 0) {
          return $true
        }
      }
      catch [IO.IOException] {
        # mintty may still be writing; retry until deadline.
      }
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $Deadline)
  return $false
}

function Send-SmokeCharacter([int]$Character, [string]$Description) {
  if (-not [EasyServerTuiSmokeNative]::PostMessage(
    $windowProcess.MainWindowHandle,
    0x0102,
    [IntPtr]$Character,
    [IntPtr]::Zero
  )) {
    throw "Could not send $Description input to the TUI terminal."
  }
}

$windowProcess = $null
try {
  $launchProgram = $Program
  $launchArgs = @($ProgramArgs)
  if ($Relaunch) {
    if ($ExitMode -ne "quit" -or $ScreenReader) {
      throw "Relaunch smoke supports only normal interactive quit mode."
    }
    $programJson = ConvertTo-Json -Compress -InputObject $Program
    $argsJson = ConvertTo-Json -Compress -InputObject @($ProgramArgs)
    $markerJson = ConvertTo-Json -Compress -InputObject $relaunchMarker
    @"
import { spawnSync } from "node:child_process";
const program = $programJson;
const args = $argsJson;
const first = spawnSync(program, args, { stdio: "inherit" });
if (first.status !== 0) process.exit(first.status ?? 1);
process.stdout.write($markerJson + "\\n");
const second = spawnSync(program, args, { stdio: "inherit" });
process.exit(second.status ?? 1);
"@ | Set-Content -LiteralPath $runner -Encoding UTF8
    $launchArgs = @($runner)
  }

  $minttyArgs = @(
    "-h", "never",
    "-t", $title,
    "-s", "$Columns,$Rows",
    "-l", (Quote-MinttyArgument $log),
    "--",
    (Quote-MinttyArgument $launchProgram)
  ) + ($launchArgs | ForEach-Object { Quote-MinttyArgument $_ })

  Start-Process -FilePath $mintty -ArgumentList $minttyArgs | Out-Null
  $windowProcess = Find-SmokeWindow ((Get-Date).AddSeconds(20))
  if ($null -eq $windowProcess) {
    $observed = if (Test-Path -LiteralPath $log) { Read-SharedText $log } else { "<no terminal log>" }
    $observed = [regex]::Replace($observed, ([char]27 + '\[[0-9;?]*[ -/]*[@-~]'), "")
    $observed = $observed.Replace("`r", " ").Replace("`n", " ").Trim()
    if ($observed.Length -gt 1200) {
      $observed = $observed.Substring($observed.Length - 1200)
    }
    throw "TUI smoke terminal window did not appear. Observed: $observed"
  }

  if (-not (Wait-ForLogText $log $ExpectedText ((Get-Date).AddSeconds(15)))) {
    $observed = if (Test-Path -LiteralPath $log) { Read-SharedText $log } else { "<no terminal log>" }
    $observed = [regex]::Replace($observed, ([char]27 + '\[[0-9;?]*[ -/]*[@-~]'), "")
    $observed = $observed.Replace("`r", " ").Replace("`n", " ").Trim()
    if ($observed.Length -gt 1200) {
      $observed = $observed.Substring($observed.Length - 1200)
    }
    throw "TUI did not render expected text before input: $ExpectedText. Observed: $observed"
  }

  if ($ResizeToNarrow) {
    $rect = New-Object EasyServerTuiSmokeNative+RECT
    if (-not [EasyServerTuiSmokeNative]::GetWindowRect($windowProcess.MainWindowHandle, [ref]$rect)) {
      throw "Could not inspect the TUI terminal window before resize."
    }
    $height = [Math]::Max(500, $rect.Bottom - $rect.Top)
    if (-not [EasyServerTuiSmokeNative]::MoveWindow(
      $windowProcess.MainWindowHandle,
      $rect.Left,
      $rect.Top,
      360,
      $height,
      $true
    )) {
      throw "Could not resize the TUI terminal window."
    }
    Start-Sleep -Seconds 1
  }

  if ($ExitMode -ne "error") {
    $character = if ($ExitMode -eq "ctrl-c") { 3 } else { [int][char]"q" }
    Send-SmokeCharacter $character $ExitMode
  }

  if ($Relaunch) {
    if (-not (Wait-ForLogText $log $relaunchMarker ((Get-Date).AddSeconds(10)))) {
      throw "First TUI launch did not exit back to the same terminal."
    }
    if (-not (Wait-ForLogTextAfter $log $relaunchMarker $ExpectedText ((Get-Date).AddSeconds(15)))) {
      throw "Second TUI launch did not render in the same terminal."
    }
    Send-SmokeCharacter ([int][char]"?") "second-launch printable shortcut"
    if (-not (Wait-ForLogTextAfter $log $relaunchMarker "Keyboard help" ((Get-Date).AddSeconds(10)))) {
      throw "Second TUI launch did not accept printable shortcut input."
    }
    Send-SmokeCharacter ([int][char]"q") "second-launch quit"
  }

  if (-not (Wait-ForExit $windowProcess.Id ((Get-Date).AddSeconds(10)))) {
    throw "TUI did not exit for smoke mode $ExitMode."
  }

  Start-Sleep -Milliseconds 300
  $text = Read-SharedText $log
  $enter = $text.IndexOf([char]27 + "[?1049h")
  $leave = $text.IndexOf([char]27 + "[?1049l")
  if ($ScreenReader) {
    if ($enter -ge 0 -or $leave -ge 0) {
      throw "Screen-reader mode must not use the alternate screen."
    }
    if (-not $text.Contains("Overview, active, focused")) {
      throw "Screen-reader smoke did not render the linear navigation state."
    }
  }
  else {
    if ($enter -lt 0) {
      throw "TUI never entered the alternate screen."
    }
    if ($leave -le $enter) {
      throw "TUI did not restore the primary screen after $ExitMode."
    }
    if ($Relaunch) {
      $enterCount = ([regex]::Matches($text, [regex]::Escape([char]27 + "[?1049h"))).Count
      $leaveCount = ([regex]::Matches($text, [regex]::Escape([char]27 + "[?1049l"))).Count
      if ($enterCount -lt 2 -or $leaveCount -lt 2) {
        throw "Sequential TUI launches did not both enter and restore the alternate screen."
      }
    }
  }
  if (-not $text.Contains($ExpectedText)) {
    throw "TUI smoke did not render expected text: $ExpectedText"
  }
  if (($ResizeToNarrow -or $Columns -lt 72) -and -not $text.Contains("compact layout")) {
    throw "TUI did not render the compact layout in a narrow terminal."
  }
  if ($NoColor -and $text -match ([char]27 + '\[(?:3[0-9]|9[0-7])m')) {
    throw "NO_COLOR smoke observed ANSI foreground color output."
  }

  Write-Output "TUI Windows smoke passed: mode=$ExitMode columns=$Columns rows=$Rows narrow=$ResizeToNarrow noColor=$NoColor screenReader=$ScreenReader"
}
finally {
  if ($null -ne $windowProcess) {
    Stop-Process -Id $windowProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -eq "mintty.exe" -and $_.CommandLine -like "*$title*"
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  Remove-Item -LiteralPath $log, $state, $daemon, $runner -Force -ErrorAction SilentlyContinue
  $env:EASYSERVER_STATE_FILE = $previousState
  $env:EASYSERVER_DAEMON_FILE = $previousDaemon
  $env:NO_COLOR = $previousNoColor
  $env:INK_SCREEN_READER = $previousScreenReader
  $env:MSYS2_ARG_CONV_EXCL = $previousMsysArgConversion
}
