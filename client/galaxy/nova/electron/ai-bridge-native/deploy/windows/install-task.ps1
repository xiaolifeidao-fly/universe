# Registers ai-bridge as a scheduled task that starts when the current user logs on.
#
#   powershell -ExecutionPolicy Bypass -File install-task.ps1 -Exe C:\ai-bridge\ai-bridge.exe
#
# Remove it again with:  Unregister-ScheduledTask -TaskName ai-bridge
#
# Why a scheduled task and not a Windows service:
#   * A service runs as LocalSystem by default and cannot see the current user's
#     Claude / Codex sign-in (%USERPROFILE%\.claude, %USERPROFILE%\.codex).
#   * ai-bridge is a plain console program. It does not answer the Service Control
#     Manager, so `sc create` would have it killed after the 30s start timeout.
#
# (Comments are in English on purpose: Windows PowerShell 5.1 misreads non-ASCII
# text in scripts saved without a BOM.)
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$TaskName = "ai-bridge"
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Exe)) { throw "ai-bridge executable not found: $Exe" }
$Exe = (Resolve-Path $Exe).Path

$action = New-ScheduledTaskAction -Execute $Exe -Argument "run" -WorkingDirectory (Split-Path $Exe)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Restart on failure, never time out: the node is meant to run for days.
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Galaxy shared pool node (ai-bridge)" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Scheduled task '$TaskName' registered and started."
