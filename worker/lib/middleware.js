// worker/lib/middleware.js - Pembacaan cookie & guard sesi untuk Hono
import { verifySession, SESSION_COOKIE } from './auth.js';

/** Ambil nilai cookie tertentu dari request. */
export function getCookie(c, name) {
    const header = c.req.header('Cookie') || '';
    for (const part of header.split(/;\s*/)) {
        const idx = part.indexOf('=');
        if (idx > 0 && part.slice(0, idx) === name) return decodeURIComponent(part.slice(idx + 1));
    }
    return null;
}

/** Middleware: wajib login (cookie sesi valid). Simpan payload ke c.set('session'). */
export async function requireAuth(c, next) {
    const token = getCookie(c, SESSION_COOKIE);
    const session = await verifySession(c.env, token);
    if (!session || !session.email) {
        return c.json({ error: 'unauthorized', message: 'Sesi tidak valid. Silakan login ulang.' }, 401);
    }
    c.set('session', session);
    await next();
}

/** Middleware: khusus superadmin (flag unlimited dari sesi, ditetapkan server-side saat login). */
export async function requireSuperadmin(c, next) {
    const session = c.get('session');
    if (!session || !session.unlimited) {
        return c.json({ error: 'forbidden', message: 'Akses khusus superadmin' }, 403);
    }
    await next();
}

/** True jika request berasal dari https (untuk flag Secure cookie). */
export function isSecureRequest(c) {
    return new URL(c.req.url).protocol === 'https:';
}
