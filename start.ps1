$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
Set-Location -LiteralPath $PSScriptRoot
try {
    $botPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $botPython)) {
        $candidates = @()
        if (Get-Command py -ErrorAction SilentlyContinue) {
            foreach ($line in (& py -0p)) {
                if ($line -match '([A-Za-z]:\\.+?\.exe)\s*$') { $candidates += $Matches[1] }
            }
        }
        if (Get-Command python -ErrorAction SilentlyContinue) {
            $candidates += (Get-Command python).Source
        }
        $localRuntimes = Join-Path $PSScriptRoot '.tools\python'
        if (Test-Path -LiteralPath $localRuntimes) {
            $candidates += Get-ChildItem -LiteralPath $localRuntimes -Filter python.exe -Recurse | Select-Object -ExpandProperty FullName
        }
        $selectedPython = $null
        foreach ($candidate in $candidates) {
            & $candidate -c 'import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)' 2>$null
            if ($LASTEXITCODE -eq 0) { $selectedPython = $candidate; break }
        }
        if (-not $selectedPython) { throw 'Install Python 3.12+ from python.org, then run start.bat again.' }
        & $selectedPython -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Cannot create .venv.' }
    }
    & $botPython -c 'import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)'
    if ($LASTEXITCODE -ne 0) { throw 'Existing .venv requires Python 3.12+. Recreate .venv with Python 3.12+.' }
    $reqHash = (Get-FileHash -LiteralPath requirements.txt -Algorithm SHA256).Hash
    $hashFile = Join-Path $PSScriptRoot '.venv\requirements.sha256'
    $savedHash = if (Test-Path -LiteralPath $hashFile) { (Get-Content -LiteralPath $hashFile -Raw).Trim() } else { '' }
    if ($reqHash -ne $savedHash) {
        & $botPython -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('pip') else 1)"
        if ($LASTEXITCODE -ne 0) {
            & $botPython -m ensurepip --upgrade
            if ($LASTEXITCODE -ne 0) { throw 'Cannot install pip in .venv.' }
        }
        & $botPython -m pip install --disable-pip-version-check -r requirements.txt
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your network.' }
        Set-Content -LiteralPath $hashFile -Value $reqHash -Encoding ASCII
    }
    if (-not (Test-Path -LiteralPath '.env')) {
        Copy-Item -LiteralPath '.env.example' -Destination '.env'
        Write-Host 'Fill BOT_TOKEN in .env, then run start.bat again.'
        exit 1
    }
    & $botPython -m smoke
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
