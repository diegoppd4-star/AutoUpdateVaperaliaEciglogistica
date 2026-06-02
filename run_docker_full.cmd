@echo off
setlocal
cd /d "%~dp0"
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker no esta instalado o no esta en PATH.
  echo Instala Docker Desktop y vuelve a ejecutar este archivo:
  echo winget install --id Docker.DockerDesktop --source winget --accept-package-agreements --accept-source-agreements
  pause
  exit /b 1
)
docker compose up --build --abort-on-container-exit
exit /b %ERRORLEVEL%
