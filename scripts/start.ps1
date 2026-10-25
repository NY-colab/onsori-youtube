param([switch]$NoBrowser, [ValidateRange(1024,65535)][int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$OnsoriRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $OnsoriRoot
$env:PATH = "$OnsoriRoot\tools\node-v24.22.1-win-x64;" + $env:PATH
$env:PYTHONUTF8 = '1'
$OnsoriPython = Join-Path $OnsoriRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $OnsoriPython)) { throw 'Run Install-OnSori.cmd first.' }
$OnsoriHeaders = @{'X-OnSori-Client'='onsori-local-v1'}
$OnsoriBaseUrl = "http://127.0.0.1:$Port"
$OnsoriReady = $false
$OnsoriHasher = [Security.Cryptography.SHA256]::Create()
try { $OnsoriIdentity = [BitConverter]::ToString($OnsoriHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($OnsoriRoot.ToLowerInvariant()))).Replace('-','').ToLowerInvariant() } finally { $OnsoriHasher.Dispose() }
$OnsoriHealth = $null
try {
    $OnsoriHealth = Invoke-RestMethod "$OnsoriBaseUrl/api/health" -Headers $OnsoriHeaders -TimeoutSec 2
    $OnsoriReady = $OnsoriHealth.status -eq 'ok' -and $OnsoriHealth.version -eq '0.1.1' -and $OnsoriHealth.installation_id -eq $OnsoriIdentity
} catch {}
if ($OnsoriHealth -and -not $OnsoriReady) { throw 'Another or older OnSori server is already running. Close it with its Stop-OnSori.cmd before starting this installation.' }
if (-not $OnsoriReady) {
    New-Item -ItemType Directory -Force (Join-Path $OnsoriRoot 'runtime') | Out-Null
    $OnsoriProcess = Start-Process -FilePath $OnsoriPython -ArgumentList @('-X','utf8','-m','uvicorn','server.app:app','--host','127.0.0.1','--port',([string]$Port)) -WorkingDirectory $OnsoriRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $OnsoriRoot 'runtime\server.log') -RedirectStandardError (Join-Path $OnsoriRoot 'runtime\server-error.log')
    $OnsoriProcess.Id | Set-Content (Join-Path $OnsoriRoot 'runtime\server.pid')
    for ($OnsoriAttempt=0; $OnsoriAttempt -lt 30; $OnsoriAttempt++) {
        Start-Sleep -Milliseconds 500
        if ($OnsoriProcess.HasExited) { throw 'Server stopped. Check runtime/server-error.log (port 8765 may be in use).' }
        try {
            $OnsoriHealth = Invoke-RestMethod "$OnsoriBaseUrl/api/health" -Headers $OnsoriHeaders -TimeoutSec 1
            if ($OnsoriHealth.status -eq 'ok' -and $OnsoriHealth.installation_id -eq $OnsoriIdentity) { $OnsoriReady=$true; break }
        } catch {}
    }
}
if (-not $OnsoriReady) { throw 'Server not ready. Check runtime/server-error.log.' }
Write-Host "OnSori: $OnsoriBaseUrl"
if (-not $NoBrowser) { Start-Process $OnsoriBaseUrl }
