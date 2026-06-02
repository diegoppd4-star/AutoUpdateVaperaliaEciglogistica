@echo off
set "PYTHON_EXE=C:\Users\diego\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if "%DATABASE_URL%"=="" (
  echo ERROR: DATABASE_URL no esta definido.
  echo Define DATABASE_URL en esta terminal antes de ejecutar este archivo.
  pause
  exit /b 1
)
cd /d "%~dp0"
"%PYTHON_EXE%" scripts\load_master_to_postgres.py
pause
