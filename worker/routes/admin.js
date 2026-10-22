// worker/routes/admin.js - Dasbor superadmin: statistik, daftar user, koreksi manual credit
import { Hono } from 'hono';
import { requireAuth, requireSuperadmin } from '../lib/middleware.js';
import { usageStats, listUsers, getUser, addBalance } from '../lib/db.js';

const router = new Hono();

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

export default router;
