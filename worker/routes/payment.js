// worker/routes/payment.js - Order QRIS dinamis per user (state di KV, TTL) + gambar QR + status untuk polling.
// Payload QRIS statis merchant dibaca dari KV 'qris_static' (diatur superadmin). Bila belum diatur,
// order tetap dibuat seperti semula (gambar QRIS statis + kode 2 digit manual) - tanpa regresi.
import { Hono } from 'hono';
import { requireAuth, getCookie } from '../lib/middleware.js';
import { verifySession, SESSION_COOKIE } from '../lib/auth.js';
import { getUser } from '../lib/db.js';
import { generateUniqueTwoDigits, saveOrder, getOrder, ORDER_TTL_SECONDS } from '../lib/qris.js';
import { buildDynamicQris, resolveStaticPayload } from '../lib/qris-emv.js';
import { qrSvg } from '../lib/qris-svg.js';

const router = new Hono();

const MIN_TOPUP = 1000;      // nominal deposit minimum (Rupiah)
const MAX_TOPUP = 10000000;  // nominal deposit maksimum (Rupiah)

/** Batas nominal dari vars (fallback ke konstanta lama). */
function amountBounds(env) {
    const min = Number(env && env.QRIS_MIN_AMOUNT);
    const max = Number(env && env.QRIS_MAX_AMOUNT);
    return {
        min: Number.isFinite(min) && min > 0 ? min : MIN_TOPUP,
        max: Number.isFinite(max) && max > 0 ? max : MAX_TOPUP,
    };
}

/** Masa berlaku order dari vars (minimum 60 detik agar tidak salah konfigurasi). */
function orderTtl(env) {
    const ttl = Number(env && env.QRIS_ORDER_TTL_SECONDS);
    return Number.isFinite(ttl) && ttl >= 60 ? Math.floor(ttl) : ORDER_TTL_SECONDS;
}

/** Token acak untuk akses gambar QR (dipakai bila cookie sesi tidak terkirim, mis. buka di perangkat lain). */
function randomToken() {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * POST /api/payment/create-qris {baseAmount, modelLabel}
 * Respons lama dipertahankan; tambahan: createdAt, expiresAt, qrToken, qrPayload, qrUrl, merchantName.
 */
router.post('/payment/create-qris', requireAuth, async (c) => {
    const session = c.get('session');
    const body = await c.req.json().catch(() => ({}));
    const { min, max } = amountBounds(c.env);
    // Nominal deposit CUSTOM: bulatkan ke rupiah lalu batasi ke rentang wajar.
    const requested = Math.round(Number(body.baseAmount));
    if (!Number.isFinite(requested) || requested < min || requested > max) {
        return c.json({ error: `Nominal deposit tidak valid (Rp ${min.toLocaleString('id-ID')} - Rp ${max.toLocaleString('id-ID')})` }, 400);
    }
    const baseAmount = requested;
    // 2 digit terakhir totalAmount harus milik kode verifikasi (indeks digit + match "exact"),
    // jadi nominal wajib kelipatan 100. Tanpa ini kode unik tidak berada di belakang nominal.
    if (baseAmount % 100 !== 0) {
        return c.json({
            error: 'Nominal deposit harus kelipatan Rp 100 agar 2 digit kode verifikasi berada di akhir nominal.',
            code: 'amount_not_multiple_of_100',
        }, 400);
    }
    const modelLabel = String(body.modelLabel || 'Deposit Saldo');

    const unique2Digit = await generateUniqueTwoDigits(c.env.ORDERS);
    const totalAmount = baseAmount + unique2Digit;
    const createdAt = Date.now();
    const ttl = orderTtl(c.env);

    // QRIS dinamis: nominal terkunci di dalam payload. Gagal build -> order tetap dibuat (alur lama).
    const resolved = await resolveStaticPayload(c.env, c.env.ORDERS);
    let qrPayload = null;
    if (resolved.payload) {
        try {
            qrPayload = buildDynamicQris(resolved.payload, totalAmount);
        } catch (e) {
            console.error('QRIS build failed:', e && e.code ? e.code : String(e && e.message ? e.message : e));
        }
    }

    const order = {
        orderId: `MKM-${createdAt}-${unique2Digit}`,
        email: session.email,
        baseAmount,
        unique2Digit,
        totalAmount,
        modelLabel,
        paid: false,
        createdAt,
        expiresAt: createdAt + ttl * 1000,
        qrToken: randomToken(),
        qrPayload,
        merchantName: resolved.merchantName || null,
    };
    await saveOrder(c.env.ORDERS, order, ttl);
    return c.json({
        ...order,
        qrUrl: qrPayload ? `/api/payment/qr/${order.orderId}?s=${order.qrToken}` : null,
    });
});

/**
 * GET /api/payment/qr/:orderId?s=token - SVG QRIS dinamis untuk order tersebut.
 * Akses: token order ATAU cookie sesi milik pemilik order (tanpa requireAuth agar jalur token tetap jalan).
 */
router.get('/payment/qr/:orderId', async (c) => {
    const order = await getOrder(c.env.ORDERS, c.req.param('orderId'));
    if (!order) {
        return c.json({ error: 'order_expired', message: 'Order tidak ditemukan atau sudah kedaluwarsa' }, 404);
    }

    const token = c.req.query('s');
    let allowed = !!(order.qrToken && token && token === order.qrToken);
    if (!allowed) {
        const session = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
        allowed = !!(session && session.email && order.email && session.email === order.email);
    }
    if (!allowed) {
        return c.json({ error: 'forbidden', message: 'Tidak berhak mengakses QRIS order ini' }, 403);
    }
    if (!order.qrPayload) {
        return c.json({ error: 'dynamic_qris_not_configured', message: 'QRIS dinamis belum diaktifkan' }, 409);
    }

    try {
        const svg = qrSvg(order.qrPayload, { size: Number(c.req.query('size')) || 320 });
        return new Response(svg, {
            status: 200,
            headers: {
                'Content-Type': 'image/svg+xml; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
                'Referrer-Policy': 'no-referrer',
            },
        });
    } catch (e) {
        if (e && e.code === 'qr_capacity') {
            return c.json({ error: 'qr_capacity', message: 'Payload QRIS melebihi kapasitas QR' }, 422);
        }
        throw e;
    }
});

/**
 * GET /api/payment/status/:orderId - polling klien; saldo dibaca dari D1 (sumber kebenaran).
 */
router.get('/payment/status/:orderId', requireAuth, async (c) => {
    const session = c.get('session');
    const order = await getOrder(c.env.ORDERS, c.req.param('orderId'));
    if (!order || order.email !== session.email) {
        return c.json({ error: 'Order tidak ditemukan' }, 404);
    }
    const user = await getUser(c.env.VO_DB, session.email);
    return c.json({
        paid: !!order.paid,
        balance: user ? user.balance : 0,
        unlimited: !!session.unlimited,
        expiresAt: order.expiresAt || null,
        qrPayloadAvailable: !!order.qrPayload,
    });
});

export default router;
