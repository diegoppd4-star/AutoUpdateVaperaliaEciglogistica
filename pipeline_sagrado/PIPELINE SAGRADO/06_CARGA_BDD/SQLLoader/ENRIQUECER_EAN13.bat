@echo off
set "NODE_EXE=C:\Users\diego\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
cd /d "%~dp0"
"%NODE_EXE%" scripts\enrich-master-ean13.js
pause
