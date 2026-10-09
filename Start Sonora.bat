@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer from https://nodejs.org/ , then reopen this launcher.
  pause
  exit /b 1
)
node tools\launch.js
if errorlevel 1 (
  pause
  exit /b 1
)
