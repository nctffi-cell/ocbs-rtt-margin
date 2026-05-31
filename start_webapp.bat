@echo off
title OCBS Margin Webapp
cd /d "%~dp0"
echo.
echo  =============================================
echo   OCBS MARGIN WEBAPP (local test)
echo   Trinh duyet se tu mo tai http://127.0.0.1:5000
echo   Dong cua so nay de tat server
echo  =============================================
echo.
python server.py
pause
