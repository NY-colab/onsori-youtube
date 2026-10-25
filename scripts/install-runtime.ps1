param([switch]$NoShortcuts, [switch]$LoginStartup)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONUTF8 = '1'
$OnsoriRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $OnsoriRoot
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'Windows x64 PC is required.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force "$OnsoriRoot\tools", "$OnsoriRoot\runtime" | Out-Null
$OnsoriLock = $null
try {
    $OnsoriLock = [IO.File]::Open("$OnsoriRoot\runtime\setup.lock", 'OpenOrCreate', 'ReadWrite', 'None')
    $missingRuntime = @('vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll') | Where-Object { -not (Test-Path -LiteralPath (Join-Path ([Environment]::SystemDirectory) $_)) }
    if ($missingRuntime) {
        Write-Output 'PROGRESS:3:Microsoft 필수 구성요소 준비 중 · Windows에서 승인을 요청할 수 있습니다'
        $vcInstaller = "$OnsoriRoot\tools\vc_redist.x64.exe"
        Invoke-WebRequest 'https://aka.ms/vc14/vc_redist.x64.exe' -OutFile $vcInstaller -UseBasicParsing -TimeoutSec 300
        $signature = Get-AuthenticodeSignature -LiteralPath $vcInstaller
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') { throw 'Microsoft runtime signature verification failed.' }
        # The signed Microsoft installer handles its own Windows elevation prompt.
        $vcProcess = Start-Process -FilePath $vcInstaller -ArgumentList @('/install','/passive','/norestart') -WindowStyle Hidden -Wait -PassThru
        if ($vcProcess.ExitCode -eq 3010) { throw 'Microsoft runtime installed. Restart Windows, then run OnSori setup again.' }
        if ($vcProcess.ExitCode -ne 0 -and $vcProcess.ExitCode -ne 1638) { throw 'Microsoft runtime installation was cancelled or failed. Run setup again after allowing the Microsoft installer.' }
    }
    function Get-VerifiedArchive($Uri, $Destination, $Hash) {
        if ((Test-Path -LiteralPath $Destination) -and (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Hash) { return }
        $temporary = "$Destination.partial"
        for ($attempt=1; $attempt -le 3; $attempt++) {
            try {
                Invoke-WebRequest -Uri $Uri -OutFile $temporary -UseBasicParsing -TimeoutSec 300
                if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $Hash) { throw 'Downloaded file checksum does not match.' }
                Move-Item -LiteralPath $temporary -Destination $Destination -Force
                return
            } catch { if ($attempt -eq 3) { throw }; Start-Sleep -Seconds (2*$attempt) }
        }
    }
    Write-Output 'PROGRESS:5:설치 도구 다운로드 중'
    $uvArchive = "$OnsoriRoot\tools\uv-0.13.5.zip"
    Get-VerifiedArchive 'https://github.com/astral-sh/uv/releases/download/0.13.5/uv-x86_64-pc-windows-msvc.zip' $uvArchive 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a'
    Expand-Archive -LiteralPath $uvArchive -DestinationPath "$OnsoriRoot\tools\uv" -Force
    $uv = "$OnsoriRoot\tools\uv\uv.exe"
    if (-not (Test-Path -LiteralPath $uv)) { throw 'uv.exe is missing from the verified archive.' }
    Write-Output 'PROGRESS:12:YouTube 연결 도구 준비 중'
    $nodeArchive = "$OnsoriRoot\tools\node-v24.22.1.zip"
    Get-VerifiedArchive 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip' $nodeArchive 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath "$OnsoriRoot\tools" -Force
    $env:PATH = "$OnsoriRoot\tools\node-v24.22.1-win-x64;" + $env:PATH
    $env:UV_PYTHON_INSTALL_DIR = "$OnsoriRoot\tools\python"
    $env:UV_CACHE_DIR = "$OnsoriRoot\tools\cache"
    Write-Output 'PROGRESS:20:전용 Python 준비 중'
    & $uv python install 3.10.20 --no-bin --no-registry
    if ($LASTEXITCODE -ne 0) { throw 'Python download failed. Check the internet connection and retry.' }
    $python = "$OnsoriRoot\.venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $python)) {
        & $uv venv --python 3.10.20 --managed-python "$OnsoriRoot\.venv"
        if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed.' }
    }
    Write-Output 'PROGRESS:30:분석 프로그램 설치 중 · 다운로드에 시간이 걸릴 수 있습니다'
    & $uv pip install --python $python -r "$OnsoriRoot\requirements.txt"
    if ($LASTEXITCODE -ne 0) { throw 'Package installation failed. Check the internet connection and retry.' }
    & $uv pip check --python $python
    if ($LASTEXITCODE -ne 0) { throw 'Package compatibility check failed.' }
    & $python -X utf8 "$OnsoriRoot\scripts\prepare_models.py"
    if ($LASTEXITCODE -ne 0) { throw 'Model preparation failed. Check the internet connection and retry.' }
    if (-not $NoShortcuts) {
        $launcher = "$OnsoriRoot\OnSori.exe"
        if (Test-Path -LiteralPath $launcher) {
            $shell = New-Object -ComObject WScript.Shell
            $locations = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'OnSori'))
            if ($LoginStartup) { $locations += [Environment]::GetFolderPath('Startup') }
            foreach ($location in $locations) {
                New-Item -ItemType Directory -Force -Path $location | Out-Null
                $shortcut = $shell.CreateShortcut((Join-Path $location 'OnSori.lnk'))
                $shortcut.TargetPath = $launcher
                $shortcut.Arguments = '--launch'
                if ($location -eq [Environment]::GetFolderPath('Startup')) { $shortcut.Arguments = '--background' }
                $shortcut.WorkingDirectory = $OnsoriRoot
                $shortcut.Description = '온소리 자막 시작'
                $shortcut.Save()
            }
            $guide = $shell.CreateShortcut((Join-Path $locations[1] 'OnSori 설치 안내.lnk'))
            $guide.TargetPath = $launcher
            $guide.Arguments = '--guide'
            $guide.WorkingDirectory = $OnsoriRoot
            $guide.Save()
            if (-not $LoginStartup) {
                $startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'OnSori.lnk'
                if (Test-Path -LiteralPath $startupLink) {
                    $existing = $shell.CreateShortcut($startupLink)
                    if ($existing.TargetPath -eq $launcher -and $existing.Arguments -eq '--background') { Remove-Item -LiteralPath $startupLink }
                }
            }
        }
    }
    [IO.File]::WriteAllText("$OnsoriRoot\runtime\installation.json", '{"version":"0.1.1","ready":true}', (New-Object Text.UTF8Encoding($false)))
    Write-Output 'PROGRESS:100:설치 완료 · Chrome에 확장 프로그램을 등록해 주세요'
} finally { if ($OnsoriLock) { $OnsoriLock.Dispose() } }
