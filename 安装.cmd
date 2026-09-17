@echo off
chcp 65001 >nul
setlocal

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found in PATH.
    echo         DSH ships with a Node runtime; run tools\install.cjs with that node instead:
    echo         node "%~dp0tools\install.cjs"
    pause
    exit /b 1
)

node "%~dp0tools\install.cjs" %*
set CODE=%ERRORLEVEL%
echo.
if not "%CODE%"=="0" echo [FAILED] exit code %CODE%
pause
exit /b %CODE%
