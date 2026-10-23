// worker/routes/qris-image.js - Gambar QRIS untuk halaman billing (endpoint PUBLIK, tanpa login).
// Sumber: KV (key 'qris_image', diunggah superadmin via /api/admin/qris-image). Bila KV kosong,
// fallback 302 ke aset statis bawaan /QRS.jpg. Simpan di KV namespace ORDERS yang sudah ada
// (pakai prefix key 'qris_image' agar tidak bertabrakan dengan 'order:'/'digit:').
import { Hono } from 'hono';

const router = new Hono();

export const QRIS_IMG_KEY = 'qris_image';

router.get('/qris/image', async (c) => {
    try {
        const { value, metadata } = await c.env.ORDERS.getWithMetadata(QRIS_IMG_KEY, { type: 'arrayBuffer', cacheTtl: 30 });
        if (value && value.byteLength) {
            const type = (metadata && metadata.contentType) || 'image/jpeg';
            const ver = (metadata && metadata.ver) || '0';
            return new Response(value, {
                status: 200,
                headers: {
                    'Content-Type': type,
                    'Cache-Control': 'public, max-age=30',
                    'ETag': `"${ver}"`,
                },
            });
        }
    } catch (e) {
        // KV gagal dibaca / binding belum ada -> sajikan bawaan agar billing tetap tampil
        console.error('QRIS image read failed:', e && e.message ? e.message : String(e));
    }
    return c.redirect('/QRS.jpg', 302);
});

export default router;
