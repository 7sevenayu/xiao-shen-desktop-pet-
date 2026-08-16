@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
    echo First run: installing Electron, please wait...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo Install failed. Check your network and retry.
        pause
        exit /b 1
    )
)

set "PETDIR=%~dp0"
start "" "%PETDIR%node_modules\electron\dist\electron.exe" .
endlocal
exit /b 0
