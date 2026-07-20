# ONE-TIME setup for a STABLE, permanent public URL (same address every time).
#
# Requirements:
#   * A free Cloudflare account:            https://dash.cloudflare.com/sign-up
#   * A domain name added to that account   (any domain you own; Cloudflare's free
#     plan is fine). If you don't have one, you can register a cheap domain and add
#     it to Cloudflare, then re-run this.
#   * cloudflared installed (winget install --id Cloudflare.cloudflared)
#
# Usage (run from this folder):
#   ./setup-tunnel.ps1 -Hostname study.yourdomain.com
#
# After this completes once, start everything any time with:
#   ./run.ps1                 (window 1 - the app)
#   ./serve-public.ps1        (window 2 - the permanent tunnel)
# and your study is always at  https://study.yourdomain.com

param(
  [Parameter(Mandatory = $true)]
  [string]$Hostname,
  [string]$TunnelName = "eyetrack"
)
$ErrorActionPreference = "Stop"

$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
  $fallback = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
  if (Test-Path $fallback) { $cf = $fallback } else {
    Write-Host "cloudflared not found. Install: winget install --id Cloudflare.cloudflared" -ForegroundColor Red; exit 1
  }
}

Write-Host "STEP 1/4: Logging in to Cloudflare (a browser window will open)..." -ForegroundColor Cyan
Write-Host "Pick the domain you want to use when prompted in the browser." -ForegroundColor Cyan
& $cf tunnel login

Write-Host "STEP 2/4: Creating the named tunnel '$TunnelName'..." -ForegroundColor Cyan
& $cf tunnel create $TunnelName 2>&1 | Write-Host

Write-Host "STEP 3/4: Routing $Hostname to this tunnel..." -ForegroundColor Cyan
& $cf tunnel route dns $TunnelName $Hostname

Write-Host "STEP 4/4: Writing tunnel config..." -ForegroundColor Cyan
$cfDir = Join-Path $env:USERPROFILE ".cloudflared"
# Find the credentials file created by 'tunnel create' (named <UUID>.json).
$cred = Get-ChildItem -Path $cfDir -Filter "*.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $cred) { Write-Host "Could not find tunnel credentials in $cfDir" -ForegroundColor Red; exit 1 }

$config = @"
tunnel: $TunnelName
credentials-file: $($cred.FullName)
ingress:
  - hostname: $Hostname
    service: http://localhost:8000
  - service: http_status:404
"@
$configPath = Join-Path $cfDir "config.yml"
$config | Out-File -FilePath $configPath -Encoding utf8

# Remember the hostname for serve-public.ps1 / run.ps1 messaging.
Set-Content -Path (Join-Path $PSScriptRoot ".public-url.txt") -Value "https://$Hostname" -Encoding utf8

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Done. Your permanent study URL: https://$Hostname" -ForegroundColor Green
Write-Host "  Start it any time with:  ./run.ps1   and   ./serve-public.ps1" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
