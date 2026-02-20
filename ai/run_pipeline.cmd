@echo off
REM Run AI pipeline: fetch from backend, then weighted heat risk.
REM Run from repo root: ai\run_pipeline.cmd

cd /d "%~dp0"
if "%BACKEND_URL%"=="" set BACKEND_URL=http://localhost:3000

REM Prefer py (launcher), else python (skip Windows Store stub if it fails)
set PY=py
py -c "import sys" 2>nul || set PY=python
%PY% -c "import sys" 2>nul || (
  echo.
  echo Python is not installed or not on PATH.
  echo Install from https://www.python.org/downloads/ and tick "Add Python to PATH".
  echo Then open a new terminal and run: ai\run_pipeline.cmd
  exit /b 1
)

echo Fetching data from %BACKEND_URL% ...
%PY% -m pip install -q -r requirements.txt 2>nul
%PY% fetch_pipeline_data.py
if errorlevel 1 exit /b 1

echo Running weighted heat risk pipeline ...
%PY% weighted_heat_risk_pipeline.py --input barangay_data_today.csv --no-rolling --output barangay_heat_risk_today.csv --upload
exit /b %errorlevel%
