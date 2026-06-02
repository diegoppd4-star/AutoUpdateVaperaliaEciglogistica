@echo off
set "PYTHON_EXE=C:\Users\diego\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
cd /d "%~dp0"
"%PYTHON_EXE%" scripts\load_master_to_postgres.py --dry-run
pause
