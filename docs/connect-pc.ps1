# ============================================================================
#  connect-pc.ps1  —  friend PC  →  alexdb dashboard  (per-user, quick tunnels)
# ----------------------------------------------------------------------------
#  Friend-safe twin of Alex's start-tunnel.ps1. The differences that matter:
#    * signs in as the FRIEND'S OWN Supabase account (JWT), NEVER service_role
#    * uses Cloudflare QUICK tunnels (random *.trycloudflare.com, no domain)
#      instead of Alex's named alexdb.xyz tunnel
#    * pushes to the friend's OWN tunnel_state row (row-level security scopes it)
#
#  Put in C:\AlexPCStatus\ next to: status.py, caddy.exe, caddyfile,
#  cloudflared.exe, moonlight-web\, and login.txt
#  (login.txt = 2 lines: dashboard email, then password).
# ============================================================================
$ErrorActionPreference = 'Continue'
$base = 'C:\AlexPCStatus'
Set-Location $base
Clear-Host
Write-Host '===== connect PC to alexdb (quick tunnels) =====' -ForegroundColor Cyan

# public, safe-to-embed identifiers (same for everyone)
$supabaseUrl = 'https://ijpmivnqtlhjcrqxffwb.supabase.co'
$anonKey     = 'sb_publishable_8Q7C4q3P6h9W4MPRvjDf3g_CRF0l3qK'

# --- 1. sign in as THIS friend (email + password from login.txt) ------------
$cred = Get-Content (Join-Path $base 'login.txt')
try {
  $auth = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
    -Headers @{ apikey = $anonKey; 'Content-Type' = 'application/json' } `
    -Body (@{ email = $cred[0].Trim(); password = $cred[1].Trim() } | ConvertTo-Json)
  $jwt = $auth.access_token
  Write-Host "Signed in as $($cred[0].Trim())" -ForegroundColor Green
} catch {
  Write-Host "Sign-in FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close'; exit 1
}

# --- 2. stop any old copies -------------------------------------------------
Get-Process python, cloudflared, 'web-server', caddy -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# --- 3. start local services (same stack as Alex's launcher) ----------------
Start-Process python -ArgumentList "$base\status.py" -WorkingDirectory $base -WindowStyle Minimized | Out-Null   # /api/status on :8765
$web = "$base\moonlight-web\web-server.exe"
if (Test-Path $web) {
  Start-Process $web -WorkingDirectory "$base\moonlight-web" -WindowStyle Minimized | Out-Null                   # Moonlight stream on :8080
}
if ((Test-Path "$base\caddy.exe") -and (Test-Path "$base\caddyfile")) {
  Start-Process "$base\caddy.exe" -ArgumentList "run --config `"$base\caddyfile`"" -WorkingDirectory $base -WindowStyle Hidden | Out-Null   # :8081 -> :8080 (iframe cookies)
}
Start-Sleep -Seconds 3

# --- 4. open quick tunnels, capture the *.trycloudflare.com URLs -------------
function Start-QuickTunnel($localUrl, $log) {
  if (Test-Path $log) { Remove-Item $log -ErrorAction SilentlyContinue }
  Start-Process "$base\cloudflared.exe" `
    -ArgumentList "tunnel --no-autoupdate --url $localUrl --logfile $log" -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $log) {
      $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m) { return $m.Matches[0].Value }
    }
  }
  return $null
}
$statusUrl = Start-QuickTunnel 'http://localhost:8765' "$base\cf-status.log"   # status.py
$streamUrl = Start-QuickTunnel 'http://localhost:8081' "$base\cf-stream.log"   # caddy -> moonlight-web
Write-Host "status: $statusUrl"
Write-Host "stream: $streamUrl"

# --- 5. push to THIS friend's own row (RLS-scoped by the JWT) ---------------
if ($statusUrl -and $streamUrl) {
  try {
    $body = @{ status_url = "$statusUrl/api/status"; stream_url = $streamUrl } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/tunnel_state?on_conflict=user_id" `
      -Headers @{ apikey = $anonKey; Authorization = "Bearer $jwt"; 'Content-Type' = 'application/json';
                  Prefer = 'resolution=merge-duplicates,return=minimal' } `
      -Body $body | Out-Null
    Write-Host 'Pushed URLs to your dashboard row.' -ForegroundColor Green
  } catch { Write-Host "Push FAILED: $($_.Exception.Message)" -ForegroundColor Red }
} else {
  Write-Host 'Tunnels did not come up — check cloudflared.exe / caddy.' -ForegroundColor Red
}

# --- 6. health check + restart/close (like Alex's launcher) -----------------
function Test-Site($url) {
  for ($a = 0; $a -lt 8; $a++) {
    try { Invoke-WebRequest -Uri $url -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop | Out-Null; return $true }
    catch { if ($_.Exception.Response) { return $true }; Start-Sleep -Seconds 3 }
  }
  return $false
}
Write-Host 'Warming up...' -ForegroundColor DarkGray
Start-Sleep -Seconds 8
$okS = if ($statusUrl) { Test-Site "$statusUrl/api/status" } else { $false }
$okV = if ($streamUrl) { Test-Site $streamUrl } else { $false }
Write-Host ("STATUS: {0}" -f $(if ($okS) {'UP'} else {'DOWN'})) -ForegroundColor $(if ($okS) {'Green'} else {'Red'})
Write-Host ("STREAM: {0}" -f $(if ($okV) {'UP'} else {'DOWN'})) -ForegroundColor $(if ($okV) {'Green'} else {'Red'})
if ($okS -and $okV) {
  Read-Host 'All UP. Open alexdb.xyz, pass the decoy, pick your profile. Enter to close'
} else {
  $c = Read-Host 'Something DOWN. Type R to restart, or C to close'
  if ($c -match '^[Rr]') { & $PSCommandPath; exit }
}
