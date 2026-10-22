// worker/lib/qris.js - Penyimpanan order QRIS di KV (TTL) + pencocokan nominal webhook.
// Catatan: Map in-memory Express TIDAK boleh ditiru di Worker (isolate stateless) - semua state ke KV/D1.

const ORDER_TTL_SECONDS = 1800; // 30 menit

const orderKey = orderId => `order:${orderId}`;
const digitKey = dd => `digit:${dd}`;

/** Hasilkan 2 digit unik (11-99) yang belum dipakai order aktif. */
export async function generateUniqueTwoDigits(kv) {
    for (let attempt = 0; attempt < 90; attempt++) {
        const dd = Math.floor(Math.random() * 89) + 11;
        const occupied = await kv.get(digitKey(dd));
        if (!occupied) return dd;
    }
    // Semua digit terpakai (sangat jarang): kembalikan acak tanpa jaminan unik
    return Math.floor(Math.random() * 89) + 11;
}

/** Simpan order baru + penanda digit ber-TTL. */
export async function saveOrder(kv, order) {
    await kv.put(digitKey(order.unique2Digit), order.orderId, { expirationTtl: ORDER_TTL_SECONDS });
    await kv.put(orderKey(order.orderId), JSON.stringify(order), { expirationTtl: ORDER_TTL_SECONDS });
}

export async function getOrder(kv, orderId) {
    const raw = await kv.get(orderKey(orderId));
    return raw ? JSON.parse(raw) : null;
}

export async function markOrderPaid(kv, order) {
    order.paid = true;
    await kv.put(orderKey(order.orderId), JSON.stringify(order), { expirationTtl: ORDER_TTL_SECONDS });
    await kv.delete(digitKey(order.unique2Digit));
}

/** Ekstrak kandidat nominal dari teks notifikasi (aturan parsing QRIS MEGAKOMINDO). */
export function parseAmountsFromBody(body) {
    const rawText = String(body.notification_text || body.amount || '');
    const digitsOnly = rawText.replace(/\./g, '');
    const matches = digitsOnly.match(/\d{3,7}/g) || [];
    const parsedAmounts = matches.map(m => parseInt(m, 10));
    return { rawText, parsedAmounts };
}

/**
 * Cari order aktif yang cocok dengan nominal notifikasi:
 * totalAmount persis ATAU (amt % 100 === unique2Digit) - aturan mod-100 asli.
 * Mengembalikan order yang dicocokkan (belum ditandai paid) atau null.
 */
export async function findMatchingOrder(kv, parsedAmounts) {
    let cursor;
    do {
        const list = await kv.list({ prefix: 'order:', cursor });
        for (const key of list.keys || []) {
            const raw = await kv.get(key.name);
            if (!raw) continue;
            let order;
            try { order = JSON.parse(raw); } catch (e) { continue; }
            if (order.paid) continue;
            const matched = parsedAmounts.includes(order.totalAmount)
                || parsedAmounts.some(amt => (amt % 100) === order.unique2Digit);
            if (matched) return order;
        }
        cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
    return null;
}

export { ORDER_TTL_SECONDS };
