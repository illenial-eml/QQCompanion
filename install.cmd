@echo off
chcp 65001 >nul
rem ============================================================
rem  QQCompanion one-click install (Windows)
rem  Usage: double-click, or run  install.cmd  in a terminal
rem  Optional: install.cmd "D:\QQCompanion"
rem ============================================================
setlocal
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=%USERPROFILE%\QQCompanion"

where powershell >nul 2>nul
if errorlevel 1 (
  echo [XX] powershell not found
  pause
  exit /b 1
)

echo Launching installer...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Dir "%TARGET%"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [XX] install failed, exit code %RC%
  pause
  exit /b %RC%
)

echo.
echo [OK] done. See the next steps above.
pause
exit /b 0
