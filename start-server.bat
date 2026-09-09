@echo off
REM ====================================================================
REM  SFTools capacity-planning fork - local server launcher
REM
REM  Double-click this to build and serve the fork at
REM      http://localhost:4200
REM  The planner opens in your browser once the server is ready.
REM  Keep this window open while you use it. Close it (or press Ctrl+C)
REM  to stop the server.
REM
REM  You can copy this file to your Desktop; it always points at the
REM  repo path below. If you move the repo, edit that one line.
REM
REM  Optional flags, e.g.  start-server.bat -NoBuild
REM      -Dev      hot-reload dev server (for editing the fork's code)
REM      -NoBuild  skip the rebuild, just serve the existing build
REM ====================================================================

title SFTools fork - http://localhost:4200
cd /d "D:\Projects\SFTools" || (echo Repo not found at D:\Projects\SFTools & pause & exit /b 1)

REM Open the planner once port 4200 starts accepting connections.
start "" powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 180;$i++){ try{ (New-Object Net.Sockets.TcpClient('localhost',4200)).Close(); Start-Process 'http://localhost:4200/stable-23855724/planner'; break } catch { Start-Sleep -Milliseconds 500 } }"

powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\run.ps1" %*

echo.
echo Server stopped.
pause
