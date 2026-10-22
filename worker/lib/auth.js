// worker/lib/auth.js - Verifikasi ID token Google (GIS) + cookie sesi HMAC untuk Worker
import { jwtVerify, createRemoteJWKSet, SignJWT } from 'jose';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const SESSION_COOKIE = 'vo_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 hari

// Ambil kunci HMAC dari env SESSION_SECRET (dikonversi jadi CryptoKey sekali pakai per panggilan - murah)
async function sessionKey(env) {
    const secret = new TextEncoder().encode(env.SESSION_SECRET || 'dev-secret-ganti-di-prod');
    return crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * Verifikasi credential ID token dari Google Identity Services.
 * Mengembalikan { sub, email, name } atau melempar Error jika tidak valid.
 */
export async function verifyGoogleCredential(credential, googleClientId) {
    if (!googleClientId) throw new Error('GOOGLE_CLIENT_ID belum dikonfigurasi');
    const { payload } = await jwtVerify(credential, GOOGLE_JWKS, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: googleClientId,
    });
    if (!payload.email) throw new Error('Token tidak memuat email');
    return { sub: payload.sub, email: payload.email, name: payload.name || String(payload.email).split('@')[0] };
}

/** Tandatangani JWT sesi internal (HS256) berisi profil user + flag unlimited. */
export async function signSession(env, user) {
    return await new SignJWT({ email: user.email, sub: user.sub, name: user.name, unlimited: !!user.unlimited })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(`${SESSION_MAX_AGE}s`)
        .sign(await sessionKey(env));
}

/** Verifikasi JWT sesi internal; mengembalikan payload atau null. */
export async function verifySession(env, token) {
    if (!token) return null;
    try {
        const { payload } = await jwtVerify(token, await sessionKey(env));
        return payload;
    } catch (e) {
        return null;
    }
}

/** Header Set-Cookie untuk sesi (HttpOnly, SameSite=Lax, Secure saat request https). */
export function sessionCookie(token, secure) {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearedSessionCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export { SESSION_COOKIE };
