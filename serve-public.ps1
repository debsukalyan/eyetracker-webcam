# Make the running app reachable on the internet.
#   * If you ran setup-tunnel.ps1, this uses your PERMANENT URL (same every time).
#   * Otherwise it falls back to a temporary random trycloudflare URL.
#
# Run ./run.ps1 first (the app), then this in a second window.
$ErrorActionPreference = "Stop"

$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
  $fallback = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
  if (Test-Path $fallback) { $cf = $fallback } else {
    Write-Host "cloudflared not found. Install: winget install --id Cloudflare.cloudflared" -ForegroundColor Red; exit 1
  }
}

# Is the local app running?
try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:8000/api/studies" | Out-Null }
catch {
  Write-Host "The app is not running on http://localhost:8000 — start it first:  ./run.ps1" -ForegroundColor Red
  exit 1
}

$configPath = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
if (Test-Path $configPath) {
  $url = ""
  $urlFile = Join-Path $PSScriptRoot ".public-url.txt"
  if (Test-Path $urlFile) { $url = Get-Content $urlFile -Raw }
  Write-Host "Starting your PERMANENT tunnel..." -ForegroundColor Green
  if ($url) { Write-Host "Study URL: $($url.Trim())" -ForegroundColor Green }
  Write-Host "Open the researcher console at that URL, generate links, share. Ctrl+C to stop." -ForegroundColor Cyan
  & $cf tunnel run
} else {
  Write-Host "No permanent tunnel configured (run ./setup-tunnel.ps1 once to get a fixed URL)." -ForegroundColor Yellow
  Write-Host "Starting a TEMPORARY tunnel — look for the https://<random>.trycloudflare.com line:" -ForegroundColor Cyan
  & $cf tunnel --url http://localhost:8000
}
