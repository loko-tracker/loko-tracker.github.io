@echo off
chcp 65001 >nul
title KHL tracker - вход
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Python не найден в PATH.
  echo.
  pause
  exit /b 1
)

python setup_login.py
pause
