// worker/routes/download-registry.js - Daftar isi file proyek untuk "Pusat Unduh".
// Terpisah dari download.js agar route tidak mengimpor dirinya sendiri (siklus ESM membuat
// modul tidak teresolusi saat build). File .js worker dibaca lewat atribut `with { type: 'text' }`
// yang diproses bundler Cloudflare (sama dengan esbuild --loader). Rahasia (.env/.dev.vars) TIDAK ada.

import readmeMd from '../../README.md' with { type: 'text' };
import envTemplate from '../../ENV_TEMPLATE.env' with { type: 'text' };
import startBat from '../../start_app.bat' with { type: 'text' };
import pushBat from '../../push_to_github.bat' with { type: 'text' };
import gitignore from '../../.gitignore' with { type: 'text' };
import macroFile from '../../qris_megakomindo_verifier.macro' with { type: 'text' };
import wranglerToml from '../../wrangler.toml' with { type: 'text' };
import schemaSql from '../../schema.sql' with { type: 'text' };
import pkgJson from '../../package.json' with { type: 'text' };
import workerIndex from '../index.js' with { type: 'text' };
import libAuth from '../lib/auth.js' with { type: 'text' };
import libDb from '../lib/db.js' with { type: 'text' };
import libAi from '../lib/ai.js' with { type: 'text' };
import libQris from '../lib/qris.js' with { type: 'text' };
import libMiddleware from '../lib/middleware.js' with { type: 'text' };
import routeAuth from './auth.js' with { type: 'text' };
import routeAnalyze from './analyze.js' with { type: 'text' };
import routePayment from './payment.js' with { type: 'text' };
import routeWebhook from './webhook.js' with { type: 'text' };
import routeAdmin from './admin.js' with { type: 'text' };
import routeDownloadSelf from './download.js' with { type: 'text' };
import registrySelf from './download-registry.js' with { type: 'text' };

// path relatif (POSIX) -> isi teks: file root + backend Worker
export const EMBEDDED = {
    'README.md': readmeMd,
    'ENV_TEMPLATE.env': envTemplate,
    'start_app.bat': startBat,
    'push_to_github.bat': pushBat,
    '.gitignore': gitignore,
    'qris_megakomindo_verifier.macro': macroFile,
    'wrangler.toml': wranglerToml,
    'schema.sql': schemaSql,
    'package.json': pkgJson,
    'worker/index.js': workerIndex,
    'worker/lib/auth.js': libAuth,
    'worker/lib/db.js': libDb,
    'worker/lib/ai.js': libAi,
    'worker/lib/qris.js': libQris,
    'worker/lib/middleware.js': libMiddleware,
    'worker/routes/auth.js': routeAuth,
    'worker/routes/analyze.js': routeAnalyze,
    'worker/routes/payment.js': routePayment,
    'worker/routes/webhook.js': routeWebhook,
    'worker/routes/admin.js': routeAdmin,
    'worker/routes/download.js': routeDownloadSelf,
    'worker/routes/download-registry.js': registrySelf,
};

// File public/ yang boleh diunduh (frontend lengkap - disajikan dari Assets binding)
export const PUBLIC_FILES = [
    'public/index.html',
    'public/app.html',
    'public/admin.html',
    'public/css/styles.css',
    'public/js/state.js',
    'public/js/tenant.js',
    'public/js/api.js',
    'public/js/ui.js',
    'public/js/history.js',
    'public/js/auth.js',
    'public/js/payment.js',
    'public/js/studio.js',
    'public/js/frames.js',
    'public/js/playback.js',
    'public/js/deploy.js',
    'public/js/app.js',
];
