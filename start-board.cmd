@echo off
setlocal
cd /d "%~dp0"
set "BOARD_PORT=7401"
set "BOARD_URL=http://127.0.0.1:%BOARD_PORT%/"

netstat -ano | findstr /R /C:":%BOARD_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo Board is already running on port %BOARD_PORT%.
  echo Opening %BOARD_URL%
  if not defined AGENTBUS_NO_BROWSER start "" "%BOARD_URL%"
  ping -n 3 127.0.0.1 >nul 2>&1
  exit /b 0
)

echo Starting AgentBus board on %BOARD_URL%
echo Close this window, or click "exit board" in the page, to stop it.
echo.

if not defined AGENTBUS_NO_BROWSER (
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%BOARD_URL%'" >nul 2>&1
)

node "bus\board.mjs" --port %BOARD_PORT%
if errorlevel 1 (
  echo.
  echo Board exited with an error. Port %BOARD_PORT% may be in use.
  pause
)
exit /b 0
