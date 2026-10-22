// worker/routes/download.js - "Pusat Unduh": daftar + isi file proyek, whitelist ketat.
// Sumber: file public/ lewat binding ASSETS; file root & worker lewat registry text-import.
// Keamanan: .env TIDAK PERNAH termasuk whitelist; path dengan '..' ditolak.
import { Hono } from 'hono';
import { EMBEDDED, PUBLIC_FILES } from './download-registry.js';

const router = new Hono();

function sanitizeRequested(rel) {
    if (!rel) return null;
    const normalized = decodeURIComponent(String(rel)).split('\\').join('/').replace(/^\/+/, '');
    if (normalized.includes('..')) return null;
    const base = normalized.split('/').pop() || '';
    // Rahasia apa pun tidak pernah boleh diunduh (ENV_TEMPLATE.env tetap aman karena bukan .env asli)
    if (base === '.env' || base === '.dev.vars' || base.endsWith('.env.local')) return null;
    return normalized;
}

router.get('/files', (c) => {
    const files = [...Object.keys(EMBEDDED), ...PUBLIC_FILES].sort();
    return c.json({ files });
});

router.get('/file/*', async (c) => {
    const rel = sanitizeRequested(c.req.path.split('/file/')[1] || '');
    if (!rel) return c.json({ error: 'Path tidak valid' }, 400);

    if (Object.prototype.hasOwnProperty.call(EMBEDDED, rel)) {
        return c.text(EMBEDDED[rel], 200, { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    if (PUBLIC_FILES.includes(rel)) {
        const assetUrl = new URL('/' + rel.replace(/^public\//, ''), c.req.url);
        const res = await c.env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
        if (!res.ok) return c.json({ error: 'File tidak ditemukan' }, 404);
        return c.text(await res.text(), 200, { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    return c.json({ error: 'File tidak ada dalam daftar unduhan' }, 404);
});

export default router;
