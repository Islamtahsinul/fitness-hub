@echo off
rem Fitness Hub tunnel for Windows: forwards 127.0.0.1:8642 on this PC to the hub's private socket
rem on your home server, then opens the hub in your browser as soon as it answers through the tunnel.
rem Usage: double-click and answer the two questions, or run
rem   connect_from_pc.bat USER@HOMESERVER UID
rem UID is your numeric user ID on the server: run  id -u  there (the hosting report gives it).
if "%~1"==":poll" goto :poll
setlocal EnableExtensions EnableDelayedExpansion
title Fitness Hub tunnel
set "PORT=8642"
if not "%FITNESS_HUB_LOCAL_PORT%"=="" (
  if not "%FITNESS_HUB_TESTING%"=="1" (
    echo FITNESS_HUB_LOCAL_PORT is for the tests only ^(with FITNESS_HUB_TESTING=1^): the hub needs local port 8642.
    goto :fail
  )
  set "PORT=%FITNESS_HUB_LOCAL_PORT%"
)
echo Opens an SSH tunnel to the Fitness Hub on your home server.
echo The hub stays private: only this PC (via 127.0.0.1) can reach it, through your SSH login.
echo.
where ssh >nul 2>nul || (
  echo ssh was not found. Turn on the OpenSSH Client: Settings ^> System ^> Optional features.
  goto :fail
)
set "SERVER=%~1"
set "SUID=%~2"
if "%~1"=="--" (
  set "SERVER=%~2"
  set "SUID=%~3"
)
if "!SERVER!"=="" set /p "SERVER=Home server login (for example user@homeserver): "
set "SERVER=!SERVER:"=!"
if "!SERVER!"=="" (
  echo No server login given.
  goto :fail
)
if "!SERVER:~0,1!"=="-" goto :badserver
for /f "eol=. delims=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._@-" %%A in ("!SERVER!") do goto :badserver
if "!SUID!"=="" set /p "SUID=Your user ID on the server (run  id -u  there): "
set "SUID=!SUID:"=!"
if "!SUID!"=="" goto :baduid
for /f "delims=0123456789" %%A in ("!SUID!") do goto :baduid
netstat -an | findstr /R /C:":%PORT% .*LISTENING" >nul && (
  echo Port %PORT% is already in use on this PC. If a copy of the hub is running here, close its window, then try again.
  goto :fail
)
set "SOCK=/run/user/!SUID!/fitness-hub/hub.sock"
echo Tunnel: http://127.0.0.1:%PORT%/ on this PC -^> !SOCK! on !SERVER!
start "" /b cmd /d /c ""%~f0" :poll %PORT%"
echo Keep this window open while you use the hub; close it (or press Ctrl+C) to disconnect.
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:%PORT%:!SOCK! -- "!SERVER!"
echo.
echo The tunnel has closed. If it closed straight away, read the message above
echo (and the troubleshooting table in the hosting guide, section 8).
goto :end

:badserver
echo That doesn't look like user@host: !SERVER!
goto :fail

:baduid
echo Your user ID on the server must be a number (run  id -u  there).
goto :fail

:poll
rem Background helper: wait until the hub answers through the tunnel, then open the browser once.
setlocal
set "PORT=%~2"
for /l %%i in (1,1,90) do (
  curl.exe -q -s --noproxy * --max-time 2 "http://127.0.0.1:%PORT%/api/health" 2>nul | findstr /C:"fitness-hub" >nul && (
    if "%FITNESS_HUB_TESTING%"=="1" if not "%FITNESS_HUB_OPEN_CMD%"=="" (
      %FITNESS_HUB_OPEN_CMD% http://127.0.0.1:%PORT%/
      exit /b 0
    )
    echo The hub answers through the tunnel: opening http://127.0.0.1:%PORT%/
    start "" "http://127.0.0.1:%PORT%/"
    exit /b 0
  )
  ping -n 2 127.0.0.1 >nul
)
exit /b 1

:fail
echo.
if not "%FITNESS_HUB_TESTING%"=="1" pause
exit /b 1

:end
if not "%FITNESS_HUB_TESTING%"=="1" pause
exit /b 0
