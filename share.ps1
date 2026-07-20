# Expose your locally-running study over a temporary PUBLIC HTTPS URL, so you can
# send participation links to people anywhere. The webcam REQUIRES https on any
# non-localhost address, which this provides.
#
# Prerequisites:
#   1. The app must already be running in another window:  ./run.ps1
#   2. cloudflared must be installed:  winget install --id Cloudflare.cloudflared
#
# Usage:  ./share.ps1
# It prints a https://<random>.trycloudflare.com URL. Open the RESEARCHER CONSOLE
# at THAT url, go to your study's Participants tab, generate links there, and share
# them — the links will automatically use the public URL.

$ErrorActionPreference = "Stop"

# Find cloudflared on PATH, or fall back to the default winget install location
# (a freshly-installed cloudflared may not be on PATH until you open a new terminal).
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
  $fallback = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
  if (Test-Path $fallback) { $cf = $fallback }
}
if (-not $cf) {
  Write-Host "cloudflared is not installed." -ForegroundColor Red
  Write-Host "Install it with:  winget install --id Cloudflare.cloudflared" -ForegroundColor Yellow
  Write-Host "(then re-run ./share.ps1)" -ForegroundColor Yellow
  exit 1
}

# Quick sanity check that the local app is up.
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:8000/api/studies" | Out-Null
} catch {
  Write-Host "The app does not seem to be running on http://localhost:8000" -ForegroundColor Red
  Write-Host "Start it first in another window:  ./run.ps1" -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "Creating a public HTTPS tunnel to http://localhost:8000 ..." -ForegroundColor Cyan
Write-Host "Look for the https://<something>.trycloudflare.com line below," -ForegroundColor Cyan
Write-Host "open the RESEARCHER CONSOLE at that URL, then generate + share links." -ForegroundColor Cyan
Write-Host "Keep this window open for as long as you need remote access. Ctrl+C to stop." -ForegroundColor Cyan
Write-Host ""

& $cf tunnel --url http://localhost:8000
