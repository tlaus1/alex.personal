$ErrorActionPreference = 'Continue'
$base = 'C:\AlexPCStatus'
$supabaseUrl = 'https://ijpmivnqtlhjcrqxffwb.supabase.co'
$keyFile = Join-Path $base 'supabase.key'
$rustdeskApi = Join-Path $base 'rustdesk-api'
$statusUrl = 'https://status.alexdb.xyz/api/status'
$streamUrl = 'https://stream.alexdb.xyz'
$rustdeskUrl = 'https://rustdesk.alexdb.xyz/webclient/'
$calcUrl = 'https://calc.alexdb.xyz/api/calc/health'
Set-Location $base
Clear-Host
Write-Host '===== AlexPC Launcher (named tunnel) =====' -ForegroundColor Cyan
Get-Process python, cloudflared, 'web-server', caddy, hbbs, hbbr -ErrorAction SilentlyContinue | ForEach-Object {
Write-Host "Stopping old: $($_.Name)" -ForegroundColor DarkGray
$_ | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500
Write-Host 'status.py...' -NoNewline
Start-Process python -ArgumentList "$base\status.py" -WorkingDirectory $base -WindowStyle Minimized | Out-Null
Write-Host ' OK' -ForegroundColor Green
$calcBridge = "$base\calc-bridge.py"
if (Test-Path $calcBridge) {
Start-Process python -ArgumentList $calcBridge -WorkingDirectory $base -WindowStyle Minimized | Out-Null
Write-Host 'calc-bridge OK' -ForegroundColor Green
}
$webServer = "$base\moonlight-web\web-server.exe"
if (Test-Path $webServer) {
Start-Process $webServer -WorkingDirectory "$base\moonlight-web" -WindowStyle Minimized | Out-Null
Write-Host 'web-server OK' -ForegroundColor Green
}
if (Test-Path "$rustdeskApi\docker-compose.yml") {
Push-Location $rustdeskApi
docker compose up -d 2>&1 | Out-Null
Pop-Location
Write-Host 'rustdesk-api OK' -ForegroundColor Green
}
Start-Sleep -Seconds 2
$caddyFile = "$base\Caddyfile"
if ((Test-Path "$base\caddy.exe") -and (Test-Path $caddyFile)) {
Start-Process "$base\caddy.exe" -ArgumentList "run --config `"$caddyFile`"" -WorkingDirectory $base -WindowStyle Hidden | Out-Null
Write-Host 'Caddy OK' -ForegroundColor Green
}
Start-Sleep -Seconds 1
Start-Process "$base\cloudflared.exe" -ArgumentList 'tunnel run alexpc' -WorkingDirectory $base -WindowStyle Hidden | Out-Null
Write-Host 'Named tunnel OK' -ForegroundColor Green
if (Test-Path $keyFile) {
try {
$key = (Get-Content $keyFile -Raw).Trim()
$body = @{ id = 1; status_url = $statusUrl; stream_url = $streamUrl; mac_stream_url = $rustdeskUrl; updated_at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
$headers = @{ 'apikey' = $key; 'Authorization' = "Bearer $key"; 'Content-Type' = 'application/json'; 'Prefer' = 'return=minimal' }
Invoke-RestMethod -Uri "$supabaseUrl/rest/v1/tunnel_state?id=eq.1" -Method Patch -Headers $headers -Body $body | Out-Null
Write-Host 'Supabase OK' -ForegroundColor Green
} catch {
Write-Host "Supabase FAILED: $($_.Exception.Message)" -ForegroundColor Red
}
}
function Test-Site($url) {
for ($a = 0; $a -lt 8; $a++) {
try {
Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop | Out-Null
return $true
} catch {
if ($_.Exception.Response) { return $true }
Start-Sleep -Seconds 3
}
}
return $false
}
Write-Host ''
Write-Host 'Warming up...' -ForegroundColor DarkGray
Start-Sleep -Seconds 8
$okStatus = Test-Site $statusUrl
$okStream = Test-Site $streamUrl
$okRustdesk = Test-Site $rustdeskUrl
$okCalc = $true
if (Test-Path $calcBridge) { $okCalc = Test-Site $calcUrl }
Write-Host ("STATUS: {0}" -f $(if ($okStatus) {'UP'} else {'DOWN'})) -ForegroundColor $(if ($okStatus) {'Green'} else {'Red'})
Write-Host ("STREAM: {0}" -f $(if ($okStream) {'UP'} else {'DOWN'})) -ForegroundColor $(if ($okStream) {'Green'} else {'Red'})
Write-Host ("RUSTDESK: {0}" -f $(if ($okRustdesk) {'UP'} else {'DOWN'})) -ForegroundColor $(if ($okRustdesk) {'Green'} else {'Red'})
if (Test-Path $calcBridge) {
Write-Host ("CALC: {0}" -f $(if ($okCalc) {'UP'} else {'DOWN'})) -ForegroundColor $(if ($okCalc) {'Green'} else {'Red'})
}
if ($okStatus -and $okStream -and $okRustdesk -and $okCalc) {
Read-Host 'All UP. Press Enter to close'
} else {
$choice = Read-Host 'Something DOWN. Type R to restart, or C to close'
if ($choice -match '^[Rr]') { & $PSCommandPath; exit }
}
