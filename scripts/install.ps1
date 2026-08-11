param(
  [string]$ProjectPath,
  [string]$InstallRoot = $(if ($env:AGENTBRIDGE_INSTALL_ROOT) { $env:AGENTBRIDGE_INSTALL_ROOT } else { Join-Path $env:USERPROFILE '.agentbridge' }),
  [switch]$NoSetup
)

$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Version = (Get-Content -LiteralPath (Join-Path $PackageRoot 'VERSION') -Raw).Trim()
if (-not $Version) { throw 'VERSION is empty.' }
if (-not $NoSetup -and $ProjectPath) { $ResolvedProject = (Resolve-Path -LiteralPath $ProjectPath).Path }

$VersionRoot = Join-Path $InstallRoot (Join-Path 'versions' $Version)
$BinRoot = Join-Path $InstallRoot 'bin'
New-Item -ItemType Directory -Force -Path $VersionRoot, $BinRoot | Out-Null

Copy-Item -LiteralPath (Join-Path $PackageRoot 'app') -Destination $VersionRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PackageRoot 'runtime') -Destination $VersionRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PackageRoot 'release.json') -Destination $VersionRoot -Force
Copy-Item -LiteralPath (Join-Path $PackageRoot 'LICENSE') -Destination $VersionRoot -Force
Copy-Item -LiteralPath (Join-Path $PackageRoot 'bin\agentbridge.cmd') -Destination (Join-Path $BinRoot 'agentbridge.cmd') -Force

Set-Content -LiteralPath (Join-Path $InstallRoot 'current') -Value $Version -Encoding ascii
$Launcher = Join-Path $BinRoot 'agentbridge.cmd'

if (-not $NoSetup) {
  $SetupArgs = @('setup')
  if ($ResolvedProject) { $SetupArgs += $ResolvedProject }
  & $Launcher @SetupArgs
  if ($LASTEXITCODE -ne 0) { throw "AgentBridge setup failed with exit code $LASTEXITCODE." }
  $DoctorArgs = @('doctor')
  if ($ResolvedProject) { $DoctorArgs += $ResolvedProject }
  & $Launcher @DoctorArgs
  if ($LASTEXITCODE -ne 0) { throw "AgentBridge doctor failed to run with exit code $LASTEXITCODE." }
}

Write-Host "AgentBridge $Version installed in $InstallRoot"
Write-Host "Launcher: $Launcher"
Write-Host ('Full uninstall: & "{0}" uninstall-all --yes --remove-program' -f $Launcher)
Write-Host 'AgentBridge is registered globally. Restart Claude Code and Codex, then open any project.'
