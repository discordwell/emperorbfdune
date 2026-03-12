@echo off
echo [1] Killing old processes...
taskkill /f /im Game.exe 2>nul
taskkill /f /im launcher.exe 2>nul
taskkill /f /im sendinput-click.exe 2>nul
timeout /t 3 /nobreak >nul

echo [2] Starting SendInput click tool in background...
start /b C:\si.exe 400 385 45

echo [3] Launching game...
C:\Users\User\Emperor\launcher.exe

echo [4] Game exited.
pause
