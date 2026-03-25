[CmdletBinding()]
param(
  [ValidateSet("3.12", "3.13", "3.14")]
  [string]$Version = "3.13",

  [ValidateSet("User", "Machine")]
  [string]$Scope = "User",

  [string]$VenvPath
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-PackageId {
  param([string]$RequestedVersion)

  switch ($RequestedVersion) {
    "3.12" { return "Python.Python.3.12" }
    "3.13" { return "Python.Python.3.13" }
    "3.14" { return "Python.Python.3.14" }
    default { throw "Unsupported version: $RequestedVersion" }
  }
}

function Update-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($machinePath, $userPath) | Where-Object { $_ }
  $env:Path = ($parts -join ";")
}

function Find-PythonExecutable {
  $commandPython = Get-Command python -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
  $candidates = @(
    $(if ($commandPython -and $commandPython -notlike "*WindowsApps*") { $commandPython }),
    "$env:LocalAppData\Programs\Python\Python313\python.exe",
    "$env:LocalAppData\Programs\Python\Python312\python.exe",
    "$env:LocalAppData\Programs\Python\Python314\python.exe",
    "$env:ProgramFiles\Python313\python.exe",
    "$env:ProgramFiles\Python312\python.exe",
    "$env:ProgramFiles\Python314\python.exe"
  ) | Where-Object { $_ -and (Test-Path $_) }

  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }

  throw "Python executable was not found after installation."
}

function Get-PythonVersionOutput {
  param([string]$PythonExe)

  try {
    return (& $PythonExe --version 2>&1 | Out-String).Trim()
  } catch {
    return $null
  }
}

function Ensure-PythonInstalled {
  param(
    [string]$RequestedVersion,
    [string]$RequestedScope
  )

  $packageId = Get-PackageId -RequestedVersion $RequestedVersion
  Write-Step "Installing $packageId with winget"

  $installArgs = @(
    "install",
    "--id", $packageId,
    "--exact",
    "--source", "winget",
    "--accept-source-agreements",
    "--accept-package-agreements",
    "--silent"
  )

  if ($RequestedScope -eq "Machine") {
    $installArgs += @("--scope", "machine")
  } else {
    $installArgs += @("--scope", "user")
  }

  & winget @installArgs
  if ($LASTEXITCODE -ne 0) {
    if ($LASTEXITCODE -eq -1978335189) {
      Write-Step "$packageId is already installed and has no newer upgrade"
      return
    }

    try {
      $installedPython = Find-PythonExecutable
      $installedVersion = Get-PythonVersionOutput -PythonExe $installedPython
      if ($installedVersion -like "Python $RequestedVersion*") {
        Write-Step "$packageId is already installed and usable"
        return
      }
    } catch {
    }

    throw "winget install failed with exit code $LASTEXITCODE"
  }
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "winget is required but not installed on this machine."
}

Write-Step "Checking existing Python"
try {
  $existingPython = Find-PythonExecutable
} catch {
  $existingPython = $null
}
if ($existingPython) {
  $existingVersionOutput = Get-PythonVersionOutput -PythonExe $existingPython

  if ($existingVersionOutput -like "Python $Version*") {
    Write-Step "Python $Version is already available at $existingPython"
  } else {
    Ensure-PythonInstalled -RequestedVersion $Version -RequestedScope $Scope
  }
} else {
  Ensure-PythonInstalled -RequestedVersion $Version -RequestedScope $Scope
}

Write-Step "Refreshing PATH"
Update-ProcessPath

$pythonExe = Find-PythonExecutable
$pythonDir = Split-Path -Parent $pythonExe
$scriptsDir = Join-Path $pythonDir "Scripts"

if ($env:Path -notlike "*$pythonDir*") {
  $env:Path = "$pythonDir;$env:Path"
}
if ((Test-Path $scriptsDir) -and $env:Path -notlike "*$scriptsDir*") {
  $env:Path = "$scriptsDir;$env:Path"
}

Write-Step "Validating python and pip"
& $pythonExe --version
& $pythonExe -m pip --version

Write-Step "Upgrading bootstrap tooling"
& $pythonExe -m pip install --upgrade pip setuptools wheel

if ($VenvPath) {
  Write-Step "Creating virtual environment at $VenvPath"
  & $pythonExe -m venv $VenvPath
  $venvPython = Join-Path $VenvPath "Scripts\python.exe"
  & $venvPython -m pip install --upgrade pip setuptools wheel
  Write-Host "Virtual environment ready: $VenvPath" -ForegroundColor Green
}

Write-Host "Python environment is ready." -ForegroundColor Green
