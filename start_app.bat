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
    echo [INFO] Menginstal modul: wrangler, hono, jose ...
    call npm install
)

if not exist ".dev.vars" if not exist ".env" (
    echo [INFO] Membuat template .dev.vars dari .dev.vars.example...
    copy .dev.vars.example .dev.vars >nul
    echo [PERINGATAN] .dev.vars berisi placeholder. Isi API key agar AI dan login berfungsi.
    echo [INFO] Server tetap dijalankan - edit file lalu jalankan ulang bila perlu.
)

echo [INFO] Menyalakan Cloudflare Worker lokal di http://localhost:8787 ...
echo [INFO] Browser default terbuka otomatis ke aplikasi studio SETELAH server siap...

rem Buka aplikasi di browser default begitu server siap (curl retry s.d. ~40 detik), lalu 'start' URL.
start "" /b cmd /c "curl -s -o nul --retry 40 --retry-delay 1 --retry-connrefused http://localhost:8787/ && start http://localhost:8787/app.html"

npx wrangler dev
pause
