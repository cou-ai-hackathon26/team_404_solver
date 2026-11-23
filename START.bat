@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MediConnect
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then double-click START.bat again.
  pause
  exit /b
)
if not exist node_modules (
  echo Installing packages for the first time, please wait...
  call npm install --no-audit --no-fund
)
node scripts\first-run.js
echo.
echo Starting MediConnect... the browser will open at http://localhost:3000
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
call npm start
pause
