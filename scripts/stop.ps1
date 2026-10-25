$ErrorActionPreference = 'Stop'
$OnsoriRoot = Split-Path -Parent $PSScriptRoot
$OnsoriPidFile = Join-Path $OnsoriRoot 'runtime\server.pid'
if (-not (Test-Path -LiteralPath $OnsoriPidFile)) { Write-Host 'No OnSori server PID recorded.'; exit 0 }
$OnsoriServerId = [int](Get-Content -LiteralPath $OnsoriPidFile)
$OnsoriParent = Get-CimInstance Win32_Process -Filter "ProcessId = $OnsoriServerId"
if (-not $OnsoriParent) { Write-Host 'OnSori server is already stopped.'; exit 0 }
$OnsoriExpected = Join-Path $OnsoriRoot '.venv\Scripts\python.exe'
if ($OnsoriParent.ExecutablePath -ne $OnsoriExpected -or $OnsoriParent.CommandLine -notmatch 'uvicorn server\.app:app --host 127\.0\.0\.1 --port [0-9]+(?:\s|$)') { throw 'Recorded PID is not this OnSori server. Nothing was stopped.' }
# uv's Windows venv launcher may spawn one Python child. Only terminate that
# verified child and this application's recorded launcher, never all Python.
$OnsoriChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId = $OnsoriServerId"
foreach ($OnsoriChild in $OnsoriChildren) {
    if ($OnsoriChild.CommandLine -match 'uvicorn server\.app:app --host 127\.0\.0\.1 --port [0-9]+(?:\s|$)') {
        Stop-Process -Id $OnsoriChild.ProcessId -ErrorAction SilentlyContinue
    }
}
Stop-Process -Id $OnsoriServerId -ErrorAction SilentlyContinue
Write-Host 'OnSori server stopped. Interrupted analyses may need to be started again.'
