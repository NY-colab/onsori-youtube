$ErrorActionPreference = 'Stop'
$OnsoriRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $OnsoriRoot
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'uv is required. Install it with: winget install --id astral-sh.uv -e ; then reopen this installer.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warning 'YouTube URL extraction needs Node.js. Install with: winget install --id OpenJS.NodeJS.LTS -e ; then reopen the server. Local files work without Node.js.'
}
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    uv venv --python 3.10 .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed.' }
}
uv pip install --python '.venv\Scripts\python.exe' -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
uv pip check --python '.venv\Scripts\python.exe'
if ($LASTEXITCODE -ne 0) { throw 'Dependency validation failed.' }
Write-Host 'OnSori is ready. Run Start-OnSori.cmd. First analysis downloads model weights.'
