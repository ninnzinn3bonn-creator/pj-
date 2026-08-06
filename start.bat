@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
if errorlevel 1 (
  echo Local Project Register could not be started.
  echo See data\launcher.log for details.
  pause
  exit /b 1
)

endlocal
