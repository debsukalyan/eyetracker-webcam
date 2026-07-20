# One-command launcher for the In-House Eye-Tracking Platform (Windows / PowerShell).
# Creates an isolated virtualenv, installs deps, and starts the server.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$venv = Join-Path $root ".venv"

if (-not (Test-Path $venv)) {
  Write-Host "Creating virtual environment..." -ForegroundColor Cyan
  python -m venv $venv
}

$py = Join-Path $venv "Scripts\python.exe"
Write-Host "Installing dependencies..." -ForegroundColor Cyan
& $py -m pip install --quiet --upgrade pip
& $py -m pip install --quiet -r (Join-Path $root "backend\requirements.txt")

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Eye-Tracking Platform running" -ForegroundColor Green
Write-Host "  Researcher console : http://localhost:8000/" -ForegroundColor Green
Write-Host "  IMPORTANT: use 'localhost', NOT '127.0.0.1' (the webcam" -ForegroundColor Yellow
Write-Host "  library only allows camera access on localhost or https)." -ForegroundColor Yellow
Write-Host "  (participant links are generated inside a study)" -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop." -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""

Set-Location (Join-Path $root "backend")
& $py -m uvicorn app:app --host 127.0.0.1 --port 8000
