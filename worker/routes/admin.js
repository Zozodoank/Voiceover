// worker/routes/admin.js - Dasbor superadmin: statistik, daftar user, koreksi manual credit
import { Hono } from 'hono';
import { requireAuth, requireSuperadmin } from '../lib/middleware.js';
import { usageStats, listUsers, getUser, addBalance } from '../lib/db.js';
import { QRIS_IMG_KEY } from './qris-image.js';

const router = new Hono();

const QRIS_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

router.use('/admin/*', requireAuth, requireSuperadmin);

router.get('/admin/stats', async (c) => {
    return c.json(await usageStats(c.env.VO_DB));
});

router.get('/admin/users', async (c) => {
    return c.json({ users: await listUsers(c.env.VO_DB) });
});

/** POST /api/admin/adjust-credit {email, delta} - tambah/kurangi saldo user lain (koreksi manual). */
router.post('/admin/adjust-credit', async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = String((body && body.email) || '').trim().toLowerCase();
    const delta = Math.trunc(Number(body && body.delta));
    if (!email || !Number.isFinite(delta) || delta === 0) {
        return c.json({ error: 'Parameter email dan delta (bilangan bulat != 0) wajib' }, 400);
    }
    const target = await getUser(c.env.VO_DB, email);
    if (!target) return c.json({ error: 'User tidak ditemukan' }, 404);
    if (target.balance + delta < 0) return c.json({ error: 'Hasil saldo tidak boleh negatif' }, 400);
    await addBalance(c.env.VO_DB, email, delta);
    const updated = await getUser(c.env.VO_DB, email);
    return c.json({ ok: true, email, balance: updated.balance });
});

/** GET /api/admin/qris-image - status gambar QRIS yang aktif (KV vs bawaan). */
router.get('/admin/qris-image', async (c) => {
    const { value, metadata } = await c.env.ORDERS.getWithMetadata(QRIS_IMG_KEY, 'arrayBuffer');
    return c.json({
        configured: !!(value && value.byteLength),
        bytes: value ? value.byteLength : 0,
        contentType: (metadata && metadata.contentType) || null,
        ver: (metadata && metadata.ver) || null,
    });
});

/**
 * POST /api/admin/qris-image {dataUrl} - simpan gambar QRIS ke KV dari data URL base64 (<=2MB).
 * dataUrl contoh: "data:image/png;base64,iVBOR...". Digunakan halaman billing semua user.
 */
router.post('/admin/qris-image', async (c) => {
    const body = await c.req.json().catch(() => null);
    const dataUrl = String((body && body.dataUrl) || '');
    const m = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
    if (!m) return c.json({ error: 'Data gambar tidak valid (harus data URL PNG/JPG/WebP)' }, 400);
    let contentType = m[1].toLowerCase();
    if (contentType === 'image/jpg') contentType = 'image/jpeg';
    let bin;
    try {
        const s = atob(m[2]);
        bin = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i);
    } catch (e) {
        return c.json({ error: 'Gagal decode base64' }, 400);
    }
    if (bin.byteLength > QRIS_MAX_BYTES) {
        return c.json({ error: `Gambar terlalu besar (maks 2 MB, ${bin.byteLength} byte)` }, 413);
    }
    const ver = String(Date.now());
    await c.env.ORDERS.put(QRIS_IMG_KEY, bin.buffer, { metadata: { contentType, ver } });
    return c.json({ ok: true, bytes: bin.byteLength, contentType, ver });
});

/** DELETE /api/admin/qris-image - hapus override KV; billing kembali pakai aset bawaan /QRS.jpg. */
router.delete('/admin/qris-image', async (c) => {
    await c.env.ORDERS.delete(QRIS_IMG_KEY);
    return c.json({ ok: true });
});

export default router;
