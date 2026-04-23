@echo off
setlocal

REM Always run from this script's directory.
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  echo Install Node.js from https://nodejs.org/ and try again.
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm is not installed or not in PATH.
  echo Reinstall Node.js and try again.
  exit /b 1
)

if not exist "node_modules" (
  echo Dependencies not found. Installing...
  if exist "package-lock.json" (
    call npm ci
  ) else (
    call npm install
  )
  if errorlevel 1 (
    echo Failed to install dependencies.
    exit /b 1
  )
)

echo Launching app...
call npm run desktop
exit /b %errorlevel%
