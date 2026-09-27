@echo off
REM Launch the interview prep site in development mode.
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
)
echo.
echo Starting the site at http://localhost:5173
echo Press Ctrl+C to stop.
echo.
call npm run dev
