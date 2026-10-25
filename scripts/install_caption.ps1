param([switch]$SkipModelDownload)
$ErrorActionPreference = 'Stop'
$captionRoot = Split-Path -Parent $PSScriptRoot
$captionPython = Join-Path $captionRoot '.venv-caption\Scripts\python.exe'
$uvCommand = Get-Command uv -ErrorAction Stop
Push-Location -LiteralPath $captionRoot
try {
    if (-not (Test-Path -LiteralPath $captionPython)) {
        & $uvCommand.Source venv --python 3.10 .venv-caption
        if ($LASTEXITCODE -ne 0) { throw 'Caption Python 3.10 environment creation failed.' }
    }
    & $captionPython -c "import sys; assert sys.version_info[:2] == (3,10), 'CoNeTTE requires isolated Python 3.10'"
    if ($LASTEXITCODE -ne 0) { throw 'Caption environment must use Python 3.10.' }
    & $uvCommand.Source pip install --python $captionPython --index https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match -r requirements-caption.txt
    if ($LASTEXITCODE -ne 0) { throw 'Caption dependency installation failed.' }
    if (-not $SkipModelDownload) {
        & $captionPython -X utf8 server/caption_worker.py --prepare
        if ($LASTEXITCODE -ne 0) { throw 'Caption resource/model preparation failed. See JSON error above.' }
    }
    Write-Output 'CoNeTTE caption worker installed in .venv-caption (CPU).'
} finally {
    Pop-Location
}
