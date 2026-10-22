// worker/routes/webhook.js - Notifikasi pembayaran MacroDroid -> verifikasi nominal -> credit D1
import { Hono } from 'hono';
import { addBalance } from '../lib/db.js';
import { parseAmountsFromBody, findMatchingOrder, markOrderPaid } from '../lib/qris.js';

const router = new Hono();

/**
 * POST /api/webhook/macrodroid
 * Header x-macrodroid-key (atau body.key) harus sama dengan MACRODROID_SECRET_KEY.
 * Pencocokan nominal identik dengan Express lama: totalAmount persis ATAU amt % 100 === unique2Digit.
 */
router.post('/webhook/macrodroid', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const headerKey = c.req.header('x-macrodroid-key') || body.key;
    if (!c.env.MACRODROID_SECRET_KEY || headerKey !== c.env.MACRODROID_SECRET_KEY) {
        return c.json({ error: 'Invalid Key' }, 403);
    }

    const { rawText, parsedAmounts } = parseAmountsFromBody(body);
    const order = await findMatchingOrder(c.env.ORDERS, parsedAmounts);
    if (order) {
        await addBalance(c.env.VO_DB, order.email, order.baseAmount);
        await markOrderPaid(c.env.ORDERS, order);
        return c.json({ status: 'verified', orderId: order.orderId, totalAmount: order.totalAmount });
    }
    return c.json({ status: 'no_matching_order', rawText });
});

export default router;
