@echo off
setlocal
node "%~dp0bin\project-manager.js" %*
exit /b %errorlevel%
