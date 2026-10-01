@echo off
cd /d "%~dp0"
echo Servidor del motel en http://localhost:5173
echo   Cliente:   http://localhost:5173/
echo   Admin:     http://localhost:5173/#admin   (PIN 1234)
echo   Servicio:  http://localhost:5173/#servicio
echo   Checador:  http://localhost:5173/#checador
echo Cierra esta ventana para detener el servidor.
start "" http://localhost:5173/#admin
python -m http.server 5173
