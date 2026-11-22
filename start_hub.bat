@echo off
rem Fitness Hub launcher: double-click to start the hub and open it in your browser.
cd /d "%~dp0"
title Fitness Hub
echo.
echo   Fitness Hub
echo   -----------
echo   Starting the hub at http://127.0.0.1:8642/ (only this computer can see it).
echo   Your browser will open in a moment.
echo.
echo   Keep this window open while you use the hub.
echo   Closing this window (or pressing Ctrl+C) stops the hub. Your data is saved as you go.
echo.
where python >nul 2>nul
if not errorlevel 1 goto run_python
where py >nul 2>nul
if not errorlevel 1 goto run_py
echo   Python 3.10 or newer was not found. Install it from the Microsoft Store or python.org, then try again.
goto done

:run_python
python -I server.py --open
goto done

:run_py
py -3 -I server.py --open

:done
echo.
echo   The Fitness Hub has stopped. You can close this window.
pause
