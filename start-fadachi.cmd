@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0"
title Fadachi Crypto Dashboard

echo.
echo ========================================
echo   Fadachi Crypto Dashboard
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Please install Node.js first, then run this file again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not available.
  echo Please reinstall Node.js with npm enabled.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm ci
  if errorlevel 1 (
    echo.
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Opening http://127.0.0.1:5173/
start "" "http://127.0.0.1:5173/"
echo.
echo Server is starting. Keep this window open while using the app.
echo Press Ctrl+C in this window to stop the server.
echo.

call npm run dev -- --host 127.0.0.1 --port 5173 --strictPort

echo.
echo Server stopped.
pause
