# register-tasks.ps1 — register the Accounting agent's Windows Task Scheduler jobs.
#
# Run this ONLY when you are ready for the agent to run on a schedule. It does NOT
# enable live posting — that is governed by CLOSE_MODE in .env (default off). With
# no linked accounts and CLOSE_MODE=off, the tasks run completely inert.
#
#   NightlySync       — daily 02:45, read-only transaction sync
#   CloseIncremental  — daily 03:45, incremental pre-close (keeps the monthly run small)
#   MonthEndClose     — monthly day 1, 06:00, the full month-end close for the prior month
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
  @{ Name = "Accounting\NightlySync";      Args = "bin\sync.ts";                       Sc = "DAILY";   When = "02:45" },
  @{ Name = "Accounting\CloseIncremental"; Args = "bin\close-agent.ts --mode=incremental"; Sc = "DAILY";   When = "03:45" },
  @{ Name = "Accounting\MonthEndClose";    Args = "bin\close-agent.ts --mode=close";    Sc = "MONTHLY"; When = "06:00" }
)

foreach ($t in $tasks) {
  if ($Unregister) {
    schtasks /Delete /TN $t.Name /F 2>$null
    Write-Host "removed $($t.Name)"
    continue
  }
  $log = Join-Path $logs ("task-" + ($t.Name -replace '.*\\','') + ".log")
  # cmd wrapper: cd into the project, run node+tsx, append stdout/stderr to a log.
  $cmd = "cmd /c cd /d `"$root`" && `"$node`" --import tsx $($t.Args) >> `"$log`" 2>&1"
  $extra = if ($t.Sc -eq "MONTHLY") { "/D 1" } else { "" }
  schtasks /Create /TN $t.Name /TR $cmd /SC $($t.Sc) $extra /ST $t.When /RL HIGHEST /F | Out-Null
  Write-Host "registered $($t.Name) ($($t.Sc) $($t.When))"
}

if (-not $Unregister) {
  Write-Host ""
  Write-Host "Registered. The agent is INERT until you: (1) link accounts (npm run link),"
  Write-Host "and (2) set CLOSE_MODE=draft (then live) in .env. Nothing posts while CLOSE_MODE=off."
}
