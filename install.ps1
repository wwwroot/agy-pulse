#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js >= 20 is required to install agy-pulse.'
  exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallScript = Join-Path $ScriptDir 'scripts\install.mjs'

if (-not (Test-Path $InstallScript)) {
  Write-Error "Missing installer script at $InstallScript"
  exit 1
}

# PowerShell 5.1-safe argument forwarding (avoids 1-element array splat edge cases).
if ($args.Count -gt 0) {
  & node $InstallScript @args
} else {
  & node $InstallScript
}
exit $LASTEXITCODE
