// worker/routes/payment.js - Order QRIS per user (state di KV, TTL 30 menit) + status untuk polling
import { Hono } from 'hono';
import { requireAuth } from '../lib/middleware.js';
import { getUser } from '../lib/db.js';
import { generateUniqueTwoDigits, saveOrder, getOrder } from '../lib/qris.js';

const router = new Hono();

const MIN_TOPUP = 1000;      // nominal deposit minimum (Rupiah)
const MAX_TOPUP = 10000000;  // nominal deposit maksimum (Rupiah)

/**
 * POST /api/payment/create-qris {baseAmount, modelLabel}
 * Respons identik dengan Express lama: {orderId, baseAmount, unique2Digit, totalAmount, modelLabel, paid}
 */
router.post('/payment/create-qris', requireAuth, async (c) => {
    const session = c.get('session');
    const body = await c.req.json().catch(() => ({}));
    // Nominal deposit CUSTOM: bulatkan ke rupiah lalu batasi ke rentang wajar.
    const requested = Math.round(Number(body.baseAmount));
    if (!Number.isFinite(requested) || requested < MIN_TOPUP || requested > MAX_TOPUP) {
        return c.json({ error: `Nominal deposit tidak valid (Rp ${MIN_TOPUP.toLocaleString('id-ID')} - Rp ${MAX_TOPUP.toLocaleString('id-ID')})` }, 400);
    }
    const baseAmount = requested;
    const modelLabel = String(body.modelLabel || 'Deposit Saldo');

    const unique2Digit = await generateUniqueTwoDigits(c.env.ORDERS);
    const order = {
        orderId: `MKM-${Date.now()}-${unique2Digit}`,
        email: session.email,
        baseAmount,
        unique2Digit,
        totalAmount: baseAmount + unique2Digit,
        modelLabel,
        paid: false,
    };
    await saveOrder(c.env.ORDERS, order);
    return c.json(order);
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
    return c.json({ paid: !!order.paid, balance: user ? user.balance : 0, unlimited: !!session.unlimited });
});

export default router;
