[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
  throw "Virtual environment not found. Run scripts/bootstrap-dev.ps1 first."
}

Push-Location $repoRoot
try {
  Write-Host "==> Ruff" -ForegroundColor Cyan
  & $venvPython -m ruff check scripts tests
  if ($LASTEXITCODE -ne 0) {
    throw "ruff check failed with exit code $LASTEXITCODE"
  }

  Write-Host "==> Pytest" -ForegroundColor Cyan
  & $venvPython -m pytest -q
  if ($LASTEXITCODE -ne 0) {
    throw "pytest failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
