@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   手机 -^> ComfyUI  公网隧道
echo   （不用插 USB，不用同一个 WiFi，开梯子也行）
echo ============================================
echo.

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    if exist "D:\anaconda3\python.exe" set "PY=D:\anaconda3\python.exe"
)
if not defined PY (
    echo [X] 没找到 Python。
    pause
    exit /b 1
)

%PY% "%~dp0start-public.py"

echo.
echo 窗口关掉不影响隧道，但电脑重启后要重新双击本文件。
pause
