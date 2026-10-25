param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$OnsoriRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $OnsoriRoot
$OnsoriPython = Join-Path $OnsoriRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $OnsoriPython)) { throw 'Run Install-OnSori.cmd first.' }
$OnsoriHeaders = @{'X-OnSori-Client'='onsori-local-v1'}
$OnsoriReady = $false
try {
    $OnsoriHealth = Invoke-RestMethod 'http://127.0.0.1:8765/api/health' -Headers $OnsoriHeaders -TimeoutSec 2
    $OnsoriReady = $OnsoriHealth.status -eq 'ok' -and $OnsoriHealth.version -eq '0.1.0'
} catch {}
if (-not $OnsoriReady) {
    New-Item -ItemType Directory -Force (Join-Path $OnsoriRoot 'runtime') | Out-Null
    $OnsoriProcess = Start-Process -FilePath $OnsoriPython -ArgumentList @('-X','utf8','-m','uvicorn','server.app:app','--host','127.0.0.1','--port','8765') -WorkingDirectory $OnsoriRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $OnsoriRoot 'runtime\server.log') -RedirectStandardError (Join-Path $OnsoriRoot 'runtime\server-error.log')
    $OnsoriProcess.Id | Set-Content (Join-Path $OnsoriRoot 'runtime\server.pid')
    for ($OnsoriAttempt=0; $OnsoriAttempt -lt 30; $OnsoriAttempt++) {
        Start-Sleep -Milliseconds 500
        if ($OnsoriProcess.HasExited) { throw 'Server stopped. Check runtime/server-error.log (port 8765 may be in use).' }
        try {
            $OnsoriHealth = Invoke-RestMethod 'http://127.0.0.1:8765/api/health' -Headers $OnsoriHeaders -TimeoutSec 1
            if ($OnsoriHealth.status -eq 'ok') { $OnsoriReady=$true; break }
        } catch {}
    }
}
if (-not $OnsoriReady) { throw 'Server not ready. Check runtime/server-error.log.' }
Write-Host 'OnSori: http://127.0.0.1:8765'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8765' }
