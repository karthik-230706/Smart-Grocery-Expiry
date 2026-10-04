@echo off
REM Downloads a full copy of your ONLINE data to backend\backups\ on this PC.
cd /d "%~dp0backend"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules call npm install
node export-backup.js
pause
