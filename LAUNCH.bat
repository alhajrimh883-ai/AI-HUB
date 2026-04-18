@echo off
chcp 65001 >nul 2>nul
title AI-HUB - Full Launcher
color 0A

echo.
echo  ========================================
echo    WAN VIDEO STUDIO - Full Launcher
echo  ========================================
echo.

set "COMFYUI_DIR=E:\ComfyUI-Easy-Install\ComfyUI"
set "COMFYUI_PYTHON=%COMFYUI_DIR%\python_embeded\python.exe"
set "COMFYUI_MAIN=%COMFYUI_DIR%\main.py"
set "APP_DIR=%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo  [OK] Node.js %NODE_VER%

if not exist "%COMFYUI_MAIN%" (
    echo  [!!] ComfyUI not found at: %COMFYUI_DIR%
    echo      Edit LAUNCH.bat line 13 to set your ComfyUI path.
    echo  [..] Skipping ComfyUI launch, starting app only...
    goto start_app
)

curl -s -o nul -w "%%{http_code}" http://127.0.0.1:8188/system_stats > "%TEMP%\comfy_check.txt" 2>nul
set /p COMFY_STATUS=<"%TEMP%\comfy_check.txt"
del "%TEMP%\comfy_check.txt" 2>nul

if "%COMFY_STATUS%"=="200" (
    echo  [OK] ComfyUI already running
    goto start_app
)

echo  [..] Starting ComfyUI...
if exist "%COMFYUI_PYTHON%" (
    start "ComfyUI" /min cmd /c "cd /d "%COMFYUI_DIR%" && "%COMFYUI_PYTHON%" main.py --listen 127.0.0.1 --port 8188"
) else (
    start "ComfyUI" /min cmd /c "cd /d "%COMFYUI_DIR%" && python main.py --listen 127.0.0.1 --port 8188"
)

echo  [..] Waiting for ComfyUI...
set WAIT_COUNT=0

:wait_loop
timeout /t 2 >nul
set /a WAIT_COUNT+=1
curl -s -o nul -w "%%{http_code}" http://127.0.0.1:8188/system_stats > "%TEMP%\comfy_check.txt" 2>nul
set /p COMFY_STATUS=<"%TEMP%\comfy_check.txt"
del "%TEMP%\comfy_check.txt" 2>nul

if "%COMFY_STATUS%"=="200" (
    echo  [OK] ComfyUI ready!
    goto start_app
)
if %WAIT_COUNT% geq 60 (
    echo  [!!] ComfyUI timeout. Starting app anyway.
    goto start_app
)
echo  [..] Waiting... (%WAIT_COUNT%/60)
goto wait_loop

:start_app
echo.
cd /d "%APP_DIR%"
if not exist "node_modules" (
    echo  [..] Installing dependencies...
    call npm install
    echo  [OK] Dependencies installed.
)
echo.
echo  ========================================
echo   Close this window to stop the app.
echo  ========================================
echo.
call npm run dev
