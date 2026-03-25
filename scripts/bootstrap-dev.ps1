[CmdletBinding()]
param(
  [string]$VenvPath,
  [string]$PythonPath
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$requirementsPath = Join-Path $repoRoot "requirements-dev.txt"

if (-not $VenvPath) {
  $VenvPath = Join-Path $repoRoot ".venv"
}

function Resolve-Python {
  param([string]$RequestedPythonPath)

  if ($RequestedPythonPath) {
    return $RequestedPythonPath
  }

  $venvPython = Join-Path $VenvPath "Scripts\python.exe"
  if (Test-Path $venvPython) {
    return $venvPython
  }

  $candidates = @(
    "$env:LocalAppData\Programs\Python\Python313\python.exe",
    "$env:LocalAppData\Programs\Python\Python312\python.exe",
    "$env:ProgramFiles\Python313\python.exe",
    "$env:ProgramFiles\Python312\python.exe"
  ) | Where-Object { Test-Path $_ }

  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }

  throw "No usable Python interpreter found. Run scripts/install-python-env.ps1 first."
}

$pythonExe = Resolve-Python -RequestedPythonPath $PythonPath

if (-not (Test-Path $VenvPath)) {
  Write-Host "==> Creating virtual environment at $VenvPath" -ForegroundColor Cyan
  & $pythonExe -m venv $VenvPath
}

$venvPython = Join-Path $VenvPath "Scripts\python.exe"

Write-Host "==> Installing development dependencies" -ForegroundColor Cyan
& $venvPython -m pip install --upgrade pip setuptools wheel
& $venvPython -m pip install -r $requirementsPath

Write-Host "Development environment is ready." -ForegroundColor Green
