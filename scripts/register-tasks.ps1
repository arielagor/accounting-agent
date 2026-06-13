# register-tasks.ps1 — register the Accounting agent's Windows Task Scheduler jobs.
#
# Run this ONLY when you are ready for the agent to run on a schedule. Whether it
# POSTS is governed by CLOSE_MODE in .env. With no linked accounts the tasks run
# completely inert (sync finds no connections; close finds no transactions).
#
#   NightlySync       — daily 02:45, read-only transaction sync
#   CloseIncremental  — daily 03:45, incremental pre-close
#   MonthEndClose     — monthly day 1, 06:00, the full month-end close for the prior month
#
# Each task runs a generated .cmd wrapper (scripts\task-*.cmd) so there is no
# nested-quoting problem with the space in "C:\Program Files\nodejs".
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1
# Remove: powershell -ExecutionPolicy Bypass -File scripts\register-tasks.ps1 -Unregister

param([switch]$Unregister)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$logs = Join-Path $root "logs"
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs -Force | Out-Null }

$tasks = @(
  @{ Name = "Accounting\NightlySync";      Run = "bin\sync.ts";                         Sc = "DAILY";   When = "02:45"; Cmd = "task-sync.cmd" },
  @{ Name = "Accounting\CloseIncremental"; Run = "bin\close-agent.ts --mode=incremental"; Sc = "DAILY";   When = "03:45"; Cmd = "task-close-incremental.cmd" },
  @{ Name = "Accounting\MonthEndClose";    Run = "bin\close-agent.ts --mode=close";      Sc = "MONTHLY"; When = "06:00"; Cmd = "task-monthend.cmd" }
)

foreach ($t in $tasks) {
  if ($Unregister) {
    schtasks /Delete /TN $t.Name /F 2>$null | Out-Null
    Write-Host "removed $($t.Name)"
    continue
  }
  $short = ($t.Name -replace '.*\\', '')
  $log = Join-Path $logs ("task-" + $short + ".log")
  $wrapper = Join-Path $PSScriptRoot $t.Cmd
  $body = "@echo off`r`ncd /d `"$root`"`r`n`"$node`" --import tsx $($t.Run) >> `"$log`" 2>&1`r`n"
  Set-Content -Path $wrapper -Value $body -Encoding ASCII

  $common = @("/Create", "/TN", $t.Name, "/TR", $wrapper, "/SC", $t.Sc, "/ST", $t.When, "/F")
  if ($t.Sc -eq "MONTHLY") { $common += @("/D", "1") }

  # Try with highest privileges; fall back to default if that needs elevation.
  & schtasks @common /RL HIGHEST *> $null
  if ($LASTEXITCODE -ne 0) { & schtasks @common *> $null }

  if ($LASTEXITCODE -eq 0) { Write-Host "registered $($t.Name) ($($t.Sc) $($t.When))" }
  else { Write-Host "FAILED $($t.Name) (schtasks exit $LASTEXITCODE)" }
}

if (-not $Unregister) {
  Write-Host ""
  Write-Host "Registered. CLOSE_MODE in .env governs posting (off|draft|live). The tasks are inert"
  Write-Host "until accounts are linked (npm run link)."
}
