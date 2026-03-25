[CmdletBinding()]
param(
  [int]$Port = 8080,
  [string]$Host = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
$systemPython = "$env:LocalAppData\Programs\Python\Python313\python.exe"

if (Test-Path $venvPython) {
  $pythonExe = $venvPython
} elseif (Test-Path $systemPython) {
  $pythonExe = $systemPython
} else {
  throw "No Python interpreter found. Run scripts/bootstrap-dev.ps1 first."
}

Write-Host "Serving OSS Signal at http://$Host`:$Port" -ForegroundColor Cyan
& $pythonExe -m http.server $Port --bind $Host -d $repoRoot
