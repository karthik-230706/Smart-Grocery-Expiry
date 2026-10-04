@echo off
REM Copies your OLD data (backend\db.json from your PC) into the online database.
cd /d "%~dp0backend"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules call npm install
node import-local-data.js %*
pause
