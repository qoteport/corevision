@echo off
rem Core Vision: set up (first run only), build the frontend, start the server on http://localhost:8000
cd /d "%~dp0"

if not exist .venv\Scripts\python.exe (
  echo Creating Python environment...
  python -m venv .venv || goto :fail
  .venv\Scripts\python -m pip install -q -r requirements.txt || goto :fail
)
if not exist .env copy .env.example .env >nul

if not exist frontend\node_modules (
  echo Installing frontend packages...
  call npm --prefix frontend install --no-fund --no-audit || goto :fail
)
echo Building frontend...
call npm --prefix frontend run build || goto :fail

echo.
echo Core Vision is running at http://localhost:8000  (Ctrl+C to stop)
start "" http://localhost:8000
.venv\Scripts\python -m uvicorn app.main:app --app-dir backend --port 8000
goto :eof

:fail
echo Setup failed. See the messages above.
exit /b 1
