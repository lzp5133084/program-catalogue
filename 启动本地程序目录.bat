@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 本地程序目录 · 军哥懂保
echo ============================================================
echo   本地程序目录查找工具  ·  军哥懂保
echo   本机访问： http://127.0.0.1:8788
echo   局域网：   http://本机IP:8788
echo   管理员账号：18180309010
echo ============================================================
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://127.0.0.1:8788"
python server.py
echo.
echo 服务已停止，按任意键关闭窗口。
pause >nul
