@echo off
chcp 65001 >nul 2>nul
title AI-HUB
color 0A
cd /d "%~dp0"

echo.
echo  ========================================
echo    WAN VIDEO STUDIO (Debug Console)
echo  ========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do echo  [OK] Node.js %%i

if not exist "node_modules" (
    echo  [..] First run - installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo  [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo  [OK] Dependencies installed.
)

echo  [..] Starting app...
echo  [..] Use RUN.vbs for invisible launch.
echo.

call npm run dev
