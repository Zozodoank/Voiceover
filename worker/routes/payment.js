// worker/routes/payment.js - Order QRIS per user (state di KV, TTL 30 menit) + status untuk polling
import { Hono } from 'hono';
import { requireAuth } from '../lib/middleware.js';
import { getUser } from '../lib/db.js';
import { generateUniqueTwoDigits, saveOrder, getOrder } from '../lib/qris.js';

const router = new Hono();

const BASE_AMOUNTS = [1200, 1500, 1800]; // sesuai data-price di UI

/**
 * POST /api/payment/create-qris {baseAmount, modelLabel}
 * Respons identik dengan Express lama: {orderId, baseAmount, unique2Digit, totalAmount, modelLabel, paid}
 */
router.post('/payment/create-qris', requireAuth, async (c) => {
    const session = c.get('session');
    const body = await c.req.json().catch(() => ({}));
    const baseAmount = BASE_AMOUNTS.includes(Number(body.baseAmount)) ? Number(body.baseAmount) : 1200;
    const modelLabel = String(body.modelLabel || 'Model Studio');

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
