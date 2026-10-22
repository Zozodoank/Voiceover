// worker/index.js - Bootstrap Cloudflare Worker (Hono): mount seluruh endpoint /api.
// Path non-/api dilayani langsung dari static assets (public/) oleh runtime Assets.
import { Hono } from 'hono';
import authRoutes from './routes/auth.js';
import analyzeRoutes from './routes/analyze.js';
import ttsRoutes from './routes/tts.js';
import paymentRoutes from './routes/payment.js';
import webhookRoutes from './routes/webhook.js';
import adminRoutes from './routes/admin.js';
import downloadRoutes from './routes/download.js';

const app = new Hono();

app.onError((err, c) => {
    console.error('Worker error:', err && err.stack ? err.stack : String(err));
    return c.json({ error: 'server_error', message: String(err.message || err) }, 500);
});

// Endpoint publik tanpa login
app.route('/api', authRoutes);      // /api/auth/session, /api/me, /api/auth/logout
app.route('/api', webhookRoutes);   // /api/webhook/macrodroid (autentikasi via secret key)
app.route('/api/download', downloadRoutes);  // /api/download/files, /api/download/file/*

// Endpoint butuh login
app.route('/api', analyzeRoutes);   // /api/analyze
app.route('/api', ttsRoutes);       // /api/tts/voices, /api/tts/preview (pratinjau suara, tanpa debit)
app.route('/api', paymentRoutes);   // /api/payment/create-qris, /api/payment/status/:orderId
app.route('/api', adminRoutes);     // /api/admin/* (superadmin)

app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
            return app.fetch(request, env, ctx);
        }
        // Selain /api: sajikan static (landing, app.html, admin.html, css, js)
        return env.ASSETS.fetch(request);
    },
};
