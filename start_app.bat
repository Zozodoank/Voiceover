@echo off
title VO Affiliate Studio Pro - Cloudflare Worker Local Dev
color 0B
cd /d "%~dp0"

echo ==============================================================
echo      VO AFFILIATE STUDIO PRO - WORKER LOCAL LAUNCHER
echo      Merchant QRIS: MEGAKOMINDO (NMID: ID1026546396189)
echo ==============================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js belum terpasang di PC ini!
    echo Silakan instal Node.js LTS dari https://nodejs.org terlebih dahulu.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] Menginstal modul (wrangler + hono + jose)...
    call npm install
)

if not exist ".dev.vars" (
    echo [INFO] Membuat template .dev.vars dari .dev.vars.example...
    copy .dev.vars.example .dev.vars >nul
    echo [INFO] Silakan edit .dev.vars lalu isi API key, kemudian jalankan ulang file ini.
    pause
    exit /b 0
)

echo [INFO] Menyalakan Cloudflare Worker lokal di http://localhost:8787 ...
echo [INFO] Membuka Browser Default secara otomatis...

start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:8787"

npx wrangler dev
pause
