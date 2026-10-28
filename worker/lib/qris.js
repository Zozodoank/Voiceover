// worker/lib/qris.js - Penyimpanan order QRIS di KV (TTL) + pencocokan nominal webhook.
// Catatan: Map in-memory Express TIDAK boleh ditiru di Worker (isolate stateless) - semua state ke KV/D1.
// Indeks 'digit:{dd}' memetakan kode unik 2 digit -> orderId, sehingga pencocokan nominal cukup O(1) read.

const ORDER_TTL_SECONDS = 1800; // 30 menit

const orderKey = orderId => `order:${orderId}`;
const digitKey = dd => `digit:${dd}`;

/** Kode 2 digit acak 11-99 memakai CSPRNG (bukan Math.random). */
function randomTwoDigits() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return (buf[0] % 89) + 11;
}

/** Hasilkan 2 digit unik (11-99) yang belum dipakai order aktif. */
export async function generateUniqueTwoDigits(kv) {
    for (let attempt = 0; attempt < 90; attempt++) {
        const dd = randomTwoDigits();
        const occupied = await kv.get(digitKey(dd));
        if (!occupied) return dd;
    }
    // Semua digit terpakai (sangat jarang): kembalikan acak tanpa jaminan unik
    return randomTwoDigits();
}

/** Simpan order baru + penanda digit ber-TTL. */
export async function saveOrder(kv, order, ttlSeconds) {
    const ttl = Number(ttlSeconds) > 0 ? Number(ttlSeconds) : ORDER_TTL_SECONDS;
    await kv.put(digitKey(order.unique2Digit), order.orderId, { expirationTtl: ttl });
    await kv.put(orderKey(order.orderId), JSON.stringify(order), { expirationTtl: ttl });
    // Best-effort: pastikan indeks digit menunjuk order ini (dua request bersamaan bisa memilih digit yang sama).
    const owner = await kv.get(digitKey(order.unique2Digit));
    if (owner !== order.orderId) {
        await kv.put(digitKey(order.unique2Digit), order.orderId, { expirationTtl: ttl });
    }
}

export async function getOrder(kv, orderId) {
    const raw = await kv.get(orderKey(orderId));
    return raw ? JSON.parse(raw) : null;
}

export async function markOrderPaid(kv, order, ttlSeconds) {
    const ttl = Number(ttlSeconds) > 0 ? Number(ttlSeconds) : ORDER_TTL_SECONDS;
    order.paid = true;
    await kv.put(orderKey(order.orderId), JSON.stringify(order), { expirationTtl: ttl });
    await kv.delete(digitKey(order.unique2Digit));
}

/** Nominal terkecil yang masuk akal sebagai total transfer (selaras QRIS_MIN_AMOUNT). */
export const MIN_CANDIDATE_AMOUNT = 1000;

/**
 * Normalisasi token nominal menjadi deret digit utuh.
 * "50.037" -> 50037, "50.037,00" -> 50037, "50,037" -> 50037, "50.037,-" -> 50037.
 */
function normalizeAmountToken(token) {
    let s = String(token == null ? '' : token).replace(/[^\d.,]/g, '');
    if (!s) return '';
    const cut = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    const tail = cut > 0 ? s.length - cut - 1 : 0;
    if (cut > 0 && tail > 0 && tail <= 2) s = s.slice(0, cut); // pecahan (",00" / ".00")
    return s.replace(/[.,]/g, '');                              // sisanya pemisah ribuan
}

/**
 * Ekstrak kandidat nominal dari notifikasi merchant, berurutan prioritas:
 * 1) field amount eksplisit (opsional - macro MacroDroid tidak mengirimnya),
 * 2) pola "Rp 25.143" / "IDR 25,143" (titik maupun koma ribuan), 3) semua deret angka (aturan lama).
 * Nominal < MIN_CANDIDATE_AMOUNT diabaikan agar angka pendek seperti "Kode 37" tidak pernah
 * dianggap total transfer. Nominal yang sama tidak diduplikasi.
 */
export function parseAmountsFromBody(body) {
    const rawText = String((body && (body.notification_text || body.text || body.message)) || '');
    const candidates = [];
    const push = value => {
        const digits = normalizeAmountToken(value);
        if (!digits || digits.length > 13) return;
        const n = parseInt(digits, 10);
        if (!Number.isFinite(n) || n < MIN_CANDIDATE_AMOUNT || candidates.includes(n)) return;
        candidates.push(n);
    };

    if (body && body.amount != null) push(body.amount);

    const rpPattern = /(?:Rp|IDR)\.?\s*([\d.,]{3,20})/gi;
    let rest = '';      // sisa teks di luar pola Rp/IDR, agar tidak diparse ulang (mis. "50.037,00" -> "5003700")
    let lastIndex = 0;
    let m;
    while ((m = rpPattern.exec(rawText)) !== null) {
        rest += rawText.slice(lastIndex, m.index) + ' ';
        lastIndex = m.index + m[0].length;
        push(m[1]);
    }
    rest += rawText.slice(lastIndex);

    const legacyMatches = rest.replace(/[.,]/g, '').match(/\d{3,9}/g) || [];
    for (const value of legacyMatches) push(value);

    return { rawText, parsedAmounts: candidates, primaryAmount: candidates.length ? candidates[0] : null };
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

/** Ambil order dari indeks kode 2 digit (null bila tidak ada / sudah dihapus / kedaluwarsa). */
async function orderByTwoDigits(kv, dd) {
    const orderId = await kv.get(digitKey(dd));
    return orderId ? getOrder(kv, orderId) : null;
}

/**
 * Pencocokan berprioritas untuk webhook:
 * - 'exact': nominal sama persis dengan totalAmount (paling kuat, dipakai lebih dulu).
 * - 'code' : hanya kode 2 digit terakhir yang cocok (aturan lama, lebih lemah - dicatat di audit).
 * - 'scan' : jalan terakhir, scan seluruh order (kompatibilitas order lama / masa transisi deploy).
 */
export async function matchOrder(kv, parsed) {
    const amounts = Array.isArray(parsed) ? parsed : ((parsed && parsed.parsedAmounts) || []);
    const codeOf = amt => ((amt % 100) + 100) % 100;

    for (const amt of amounts) {
        const order = await orderByTwoDigits(kv, codeOf(amt));
        if (order && !order.paid && order.totalAmount === amt) return { order, amt, type: 'exact' };
    }
    for (const amt of amounts) {
        const order = await orderByTwoDigits(kv, codeOf(amt));
        if (order && !order.paid && codeOf(amt) === order.unique2Digit) return { order, amt, type: 'code' };
    }

    const scanned = await findMatchingOrder(kv, amounts);
    return scanned ? { order: scanned, amt: scanned.totalAmount, type: 'scan' } : null;
}

export { ORDER_TTL_SECONDS };
