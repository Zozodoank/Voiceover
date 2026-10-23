// worker/routes/auth.js - Sesi Google OAuth (GIS credential -> cookie vo_session)
import { Hono } from 'hono';
import { verifyGoogleCredential, signSession, sessionCookie, clearedSessionCookie } from '../lib/auth.js';
import { upsertUser, getUser, isSuperadminEmail } from '../lib/db.js';
import { requireAuth, isSecureRequest } from '../lib/middleware.js';

const router = new Hono();

/** Konfigurasi publik untuk GIS (client ID OAuth) - tanpa data sensitif. */
router.get('/auth/config', (c) => {
    return c.json({ clientId: c.env.GOOGLE_CLIENT_ID || '' });
});

/** GIS menukar ID token -> POST {credential} ke sini; balikin profil + set cookie HttpOnly. */
router.post('/auth/session', async (c) => {
    const body = await c.req.json().catch(() => null);
    const credential = body && body.credential;
    if (!credential) return c.json({ error: 'Kredensial tidak diterima' }, 400);

    let profile;
    try {
        profile = await verifyGoogleCredential(credential, c.env.GOOGLE_CLIENT_ID);
    } catch (e) {
        return c.json({ error: 'Token Google tidak valid', detail: String(e.message || e) }, 401);
    }

    const unlimited = isSuperadminEmail(c.env, profile.email);
    // Kredit gratis pendaftaran baru (saldo awal). Non-superadmin saja; login berikutnya tak menyentuh balance.
    const welcomeCredit = Math.max(0, Number(c.env.WELCOME_CREDIT ?? 3600) || 0);
    const user = await upsertUser(c.env.VO_DB, { ...profile, unlimited, initialBalance: unlimited ? 0 : welcomeCredit });
    const token = await signSession(c.env, { ...profile, unlimited });
    c.res.headers.set('Set-Cookie', sessionCookie(token, isSecureRequest(c)));
    return c.json({
        email: user.email,
        name: user.name,
        balance: user.balance,
        unlimited: !!user.unlimited,
    });
});

/** Profil + saldo terkini untuk bootstrap UI (tenant.js memanggil ini saat boot). */
router.get('/me', requireAuth, async (c) => {
    const session = c.get('session');
    const user = await getUser(c.env.VO_DB, session.email);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    return c.json({
        email: user.email,
        name: user.name,
        sub: user.sub,
        balance: user.balance,
        unlimited: !!user.unlimited,
    });
});

router.post('/auth/logout', async (c) => {
    c.res.headers.set('Set-Cookie', clearedSessionCookie());
    return c.json({ ok: true });
});

export default router;
