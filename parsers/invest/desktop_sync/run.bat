@echo off
rem WClock десктоп-синхронизация с планшетом.
rem Запуск: run.bat            — окно
rem         run.bat --once     — один проход в консоли
cd /d "%~dp0..\..\.."
if exist "venv\Scripts\python.exe" (
    set "PY=venv\Scripts\python.exe"
) else (
    set "PY=python"
)
"%PY%" -m parsers.invest.desktop_sync %*
