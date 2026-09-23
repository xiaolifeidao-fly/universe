# ai-bridge installer for Windows. The platform address is already filled in.
#
#   powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm <hub>/agent/v1/bridge/install.ps1))) -Key gpk-XXXX"
#   ... -Key gpk-XXXX -Mode export -PublicUrl http://203.0.113.7:8788
#
# -Mode picks how the node gets its work: "poll" reaches out to the platform and
# needs no public address; "export" has the platform connect back, which needs an
# address it can reach (-PublicUrl) and an open port. Both are handed straight to
# `ai-bridge register` -- this script does not interpret them.
#
# Installs to %LOCALAPPDATA%\ai-bridge so that the running user can replace the
# executable: remote upgrade swaps that file, and Program Files would need admin
# rights for every upgrade. Re-running this script upgrades in place.
#
# (Comments are in English on purpose: Windows PowerShell 5.1 misreads non-ASCII
# text in scripts saved without a BOM, and this one is piped straight from HTTP.)
param(
  [string]$Key = "",
  [string]$Name = "",
  [string]$Dir = "",
  [string]$Hub = "__HUB_URL__",
  [ValidateSet("", "poll", "export")]
  [string]$Mode = "",
  [string]$PublicUrl = "",
  # Not -Host: $Host is a read-only automatic variable in PowerShell.
  [string]$BindHost = "",
  [int]$Port = 0
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not $Hub) { throw "ai-bridge: platform address is missing (-Hub)" }
# Checked before the download so a typo does not cost a full download first.
if ($Mode -eq "export" -and -not $PublicUrl) {
  throw "ai-bridge: -Mode export needs -PublicUrl, the address the platform connects back to"
}

# The access arguments, shared by the registration call and the hints below.
$access = @()
if ($Mode) { $access += @("--mode", $Mode) }
if ($PublicUrl) { $access += @("--public-url", $PublicUrl) }
if ($BindHost) { $access += @("--host", $BindHost) }
if ($Port -gt 0) { $access += @("--port", "$Port") }
$accessHint = if ($access) { " " + ($access -join " ") } else { "" }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$platform = "windows-$arch"
Write-Host "ai-bridge: platform $platform, downloading from $Hub"

$work = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ("ai-bridge-" + [guid]::NewGuid().ToString("N")))
try {
  $archive = Join-Path $work "ai-bridge.zip"
  Invoke-WebRequest -Uri "$Hub/agent/v1/bridge/download/$platform" -OutFile $archive -UseBasicParsing

  # The checksum endpoint answers in sha256sum format: "<digest>  <file name>".
  $checksum = (Invoke-WebRequest -Uri "$Hub/agent/v1/bridge/checksum/$platform" -UseBasicParsing).Content
  $expected = ($checksum.Trim() -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLower()
  if (-not $expected) { throw "ai-bridge: could not read the expected checksum" }
  if ($actual -ne $expected.ToLower()) {
    throw "ai-bridge: checksum mismatch (expected $expected, got $actual), not installing"
  }

  Expand-Archive -Path $archive -DestinationPath $work -Force
  $src = Get-ChildItem -Path $work -Directory | Where-Object { $_.Name -like "ai-bridge-*-$platform" } | Select-Object -First 1
  if (-not $src) { throw "ai-bridge: the package does not contain the expected folder" }

  if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA "ai-bridge" }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $exe = Join-Path $Dir "ai-bridge.exe"
  # A running executable cannot be overwritten on Windows, but it can be renamed
  # away. The upgrade path in ai-bridge itself does the same thing.
  if (Test-Path $exe) {
    $backup = "$exe.old"
    if (Test-Path $backup) { Remove-Item -Force $backup }
    Move-Item -Force -Path $exe -Destination $backup
  }
  Copy-Item -Path (Join-Path $src.FullName "ai-bridge.exe") -Destination $exe -Force
  # Deployment templates travel with the package: whoever gets the machine
  # usually does not have the repository at hand.
  $deploy = Join-Path $src.FullName "deploy"
  if (Test-Path $deploy) {
    $target = Join-Path $Dir "deploy"
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Copy-Item -Path $deploy -Destination $target -Recurse -Force
  }
  $readme = Join-Path $src.FullName "README.md"
  if (Test-Path $readme) { Copy-Item -Path $readme -Destination (Join-Path $Dir "README.md") -Force }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  if (($userPath -split ';') -notcontains $Dir) {
    [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(';') + ";" + $Dir).Trim(';'), "User")
    Write-Host "ai-bridge: added $Dir to your PATH (open a new terminal to pick it up)"
  }

  $version = (& $exe version) 2>$null
  Write-Host "ai-bridge: installed $version -> $exe"

  if ($Key) {
    $arguments = @("register", "--hub", $Hub, "--key", $Key)
    if ($Name) { $arguments += @("--name", $Name) }
    $arguments += $access
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "ai-bridge: register failed" }
  }

  Write-Host ""
  Write-Host "Next steps:"
  if (-not $Key) {
    Write-Host "  1) register: $exe register --hub $Hub --key <access key>$accessHint"
    Write-Host "     Issue an access key in the console under Account -> Access keys."
    Write-Host "  2) run: $exe run"
  } else {
    Write-Host "  1) run: $exe run"
  }
  if ($Mode -eq "export") {
    Write-Host "  This machine joins as export: the platform connects back to $PublicUrl -- make sure the firewall lets that port through."
  }
  Write-Host "  To keep it running, register the scheduled task:"
  Write-Host "    powershell -ExecutionPolicy Bypass -File `"$Dir\deploy\windows\install-task.ps1`" -Exe `"$exe`""
  Write-Host "  Later upgrades: click Upgrade in the console, or run $exe upgrade on this machine."
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
