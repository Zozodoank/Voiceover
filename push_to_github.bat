@echo off
title Push VO Affiliate Studio Pro to GitHub
color 0A
cd /d "%~dp0"

echo ==============================================================
echo      AUTO PUSH KE GITHUB: Zozodoank/Voiceover.git
echo ==============================================================
echo.

where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git belum terpasang di PC ini!
    echo Silakan unduh dan instal Git dari https://git-scm.com/
    pause
    exit /b 1
)

git branch -M main
git remote remove origin >nul 2>nul
git remote add origin https://github.com/Zozodoank/Voiceover.git

git add .
set /p COMMIT_MSG="Masukkan pesan commit (Enter untuk default): "
if "%COMMIT_MSG%"=="" set COMMIT_MSG=Release: VO Affiliate Studio Enterprise + QRIS MacroDroid + Aivene Fallback

git commit -m "%COMMIT_MSG%"
git push -u origin main
pause