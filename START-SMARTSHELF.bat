@echo off
REM Double-click to start SmartShelf. Installs dependencies on first run,
REM starts the server, and opens the app in your browser.
cd /d "%~dp0backend"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
)
start "" http://localhost:4000
echo.
echo SmartShelf is starting. KEEP THIS WINDOW OPEN - closing it stops the server.
echo.
call npm start
pause
