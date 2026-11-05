@echo off
rem WClock5 — локальный запуск без Docker: веб + демоны
rem Используется для автозапуска (Планировщик заданий / shell:startup).
rem Остановка: bash sh/devops.sh stop
rem Если проект перенесён — поправьте WROOT ниже.

set "WROOT=/e/_dev/10.gpx/04.gpx_clock_beget/wclock5"

set "BASH=C:\Program Files\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=C:\Program Files\Git\usr\bin\bash.exe"
if not exist "%BASH%" (
    echo Git Bash не найден. Установите Git for Windows.
    exit /b 1
)

"%BASH%" -lc "cd '%WROOT%' && ./sh/devops.sh upall"
