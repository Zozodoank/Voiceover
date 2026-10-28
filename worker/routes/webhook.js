// worker/routes/webhook.js - Notifikasi pembayaran MacroDroid -> verifikasi nominal -> credit D1 (idempoten).
// Idempotensi: INSERT ke tabel payments (order_id UNIQUE) + UPDATE saldo dijalankan dalam satu batch
// transaksional. Kiriman ganda/replay tidak pernah mengkredit saldo dua kali.
import { Hono } from 'hono';
import { parseAmountsFromBody, matchOrder, markOrderPaid } from '../lib/qris.js';

const router = new Hono();

/** Perbandingan string constant-time sederhana untuk secret webhook. */
function safeEqual(a, b) {
    const x = String(a == null ? '' : a);
    const y = String(b == null ? '' : b);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
}

/**
 * Cari pembayaran terakhir di ledger D1 dengan nominal yang sama (7 hari terakhir).
 * Dipakai mendeteksi notifikasi replay: kode 2 digit yang sudah dibebaskan bisa dipakai order baru,
 * sehingga tanpa cek ini kiriman ganda berpotensi mengkredit order lain.
 */
async function findRecentPaymentIds(db, amounts) {
    for (const amt of amounts) {
        const row = await db.prepare(
            `SELECT order_id FROM payments
             WHERE matched_amount = ? AND created_at >= datetime('now', '-7 days')
             ORDER BY id DESC LIMIT 1`
        ).bind(amt).first();
        if (row && row.order_id) return row.order_id;
    }
    return null;
}

/**
 * POST /api/webhook/macrodroid
 * Header x-macrodroid-key (atau body.key) harus sama dengan MACRODROID_SECRET_KEY.
 * Pencocokan: totalAmount persis lebih dulu, lalu kode 2 digit, lalu scan seluruh order.
 * Selalu membalas 200 (selain kunci salah) agar MacroDroid tidak retry tanpa henti.
 */
router.post('/webhook/macrodroid', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const headerKey = c.req.header('x-macrodroid-key') || body.key;
    if (!c.env.MACRODROID_SECRET_KEY || !safeEqual(headerKey, c.env.MACRODROID_SECRET_KEY)) {
        return c.json({ error: 'Invalid Key' }, 403);
    }

    const { rawText, parsedAmounts } = parseAmountsFromBody(body);
    const hit = await matchOrder(c.env.ORDERS, parsedAmounts);
    if (!hit) {
        const replayId = await findRecentPaymentIds(c.env.VO_DB, parsedAmounts);
        if (replayId) {
            console.log(`QRIS webhook: already_credited (ledger) order=${replayId}`);
            return c.json({ status: 'already_credited', orderId: replayId });
        }
        console.log(`QRIS webhook: no_matching_order candidates=${parsedAmounts.join(',') || '-'}`);
        return c.json({ status: 'no_matching_order', rawText });
    }

    const { order, amt, type } = hit;

    // Kecocokan lemah (hanya kode 2 digit): tolak bila nominal itu sudah pernah tercatat.
    if (type !== 'exact') {
        const replayId = await findRecentPaymentIds(c.env.VO_DB, [amt]);
        if (replayId) {
            console.log(`QRIS webhook: already_credited (weak match) order=${replayId}`);
            return c.json({ status: 'already_credited', orderId: replayId });
        }
    }
    try {
        await c.env.VO_DB.batch([
            c.env.VO_DB.prepare(
                `INSERT INTO payments (order_id, email, base_amount, total_amount, matched_amount, match_type, raw_text)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(order.orderId, order.email, order.baseAmount, order.totalAmount, amt, type, String(rawText).slice(0, 500)),
            c.env.VO_DB.prepare('UPDATE users SET balance = balance + ? WHERE email = ?').bind(order.baseAmount, order.email),
        ]);
    } catch (e) {
        // order_id UNIQUE sudah terisi -> notifikasi ini pernah diproses (replay / kiriman ganda).
        if (/UNIQUE constraint failed/i.test(String(e && e.message ? e.message : e))) {
            console.log(`QRIS webhook: already_credited order=${order.orderId}`);
            return c.json({ status: 'already_credited', orderId: order.orderId });
        }
        throw e;
    }

    await markOrderPaid(c.env.ORDERS, order);
    console.log(`QRIS webhook: verified order=${order.orderId} amount=${amt} match=${type}`);
    return c.json({
        status: 'verified',
        orderId: order.orderId,
        totalAmount: order.totalAmount,
        matchedAmount: amt,
        matchType: type,
    });
});

export default router;
