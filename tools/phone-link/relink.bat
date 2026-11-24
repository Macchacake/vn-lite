@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   手机 -^> ComfyUI  USB 链路修复
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
    echo [X] 没找到 Python。请先装 Python，或手动运行 link.py。
    pause
    exit /b 1
)

%PY% "%~dp0link.py"
echo.
pause
