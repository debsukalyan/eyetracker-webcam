# ONE-COMMAND launcher: starts the app AND a temporary public HTTPS URL together.
# Run this, copy the https://<...>.trycloudflare.com URL it shows, open the
# researcher console at that URL, generate participant links, and share them.
# Press Ctrl+C (or close the window) to stop everything.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# --- 1. Python venv + deps (first run only) --------------------------------
$venv = Join-Path $root ".venv"
if (-not (Test-Path $venv)) {
  Write-Host "First-time setup: creating Python environment..." -ForegroundColor Cyan
  python -m venv $venv
}
$py = Join-Path $venv "Scripts\python.exe"
& $py -m pip install --quiet --upgrade pip
& $py -m pip install --quiet -r (Join-Path $root "backend\requirements.txt")

# --- 2. cloudflared --------------------------------------------------------
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
  $fallback = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
  if (Test-Path $fallback) { $cf = $fallback } else {
    Write-Host "cloudflared is not installed. Install it once with:" -ForegroundColor Red
    Write-Host "  winget install --id Cloudflare.cloudflared" -ForegroundColor Yellow
    exit 1
  }
}

# --- 3. Free port 8000 (clean slate, clears any leftover server) -----------
$old = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue |
       Select-Object -First 1 -ExpandProperty OwningProcess
if ($old) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }

# --- 4. Start the app (background) -----------------------------------------
Write-Host "Starting the study app..." -ForegroundColor Cyan
$applog = Join-Path $env:TEMP "eyetrack_app.log"
$app = Start-Process -FilePath $py `
  -ArgumentList @('-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8000') `
  -WorkingDirectory (Join-Path $root "backend") -PassThru -WindowStyle Hidden `
  -RedirectStandardError $applog -RedirectStandardOutput "$applog.out"

# wait until it answers
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://localhost:8000/api/studies" | Out-Null; $ready = $true; break }
  catch { Start-Sleep -Seconds 1 }
}
if (-not $ready) {
  Write-Host "App failed to start. Last log lines:" -ForegroundColor Red
  Get-Content $applog -ErrorAction SilentlyContinue | Select-Object -Last 10
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  App is running. Opening a public URL below..." -ForegroundColor Green
Write-Host "  1. Copy the https://....trycloudflare.com address that appears." -ForegroundColor Green
Write-Host "  2. Open the RESEARCHER CONSOLE at that address in your browser." -ForegroundColor Green
Write-Host "  3. Go to your study -> Participants -> Generate, and share the links." -ForegroundColor Green
Write-Host "  Keep this window open while people take the study. Ctrl+C to stop." -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""

# --- 5. Run the tunnel in the foreground (shows the URL; Ctrl+C stops) ------
try {
  & $cf tunnel --url http://localhost:8000
}
finally {
  Write-Host ""
  Write-Host "Shutting down the app..." -ForegroundColor Cyan
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
}
