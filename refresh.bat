@echo off
chcp 65001 >nul
title KHL 2026/27 - tracker
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Python не найден в PATH.
  echo   Установи Python 3 с python.org и запусти снова.
  echo.
  pause
  exit /b 1
)

python run.py %*

if errorlevel 1 (
  echo.
  echo   Что-то пошло не так. Текст ошибки выше.
  pause
)
