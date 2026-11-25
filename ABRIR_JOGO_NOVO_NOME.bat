@echo off
setlocal
cd /d "%~dp0"
node tools\live_new_name_launch.cjs --single
echo.
echo Cliente aberto com nome aleatorio. Agora abra a interface e clique em Iniciar.
pause >nul
