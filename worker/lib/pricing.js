// worker/lib/pricing.js - Harga per tier kualitas VO: default di kode, bisa diubah superadmin lewat D1.
// Dipakai bersama oleh /api/analyze (debit), /api/pricing (hidrasi UI) dan /api/admin/pricing.
import { getSettings } from './db.js';
import { TTS_TIER_IDS, TTS_TIER_META } from './tts.js';

export const DEFAULT_TIER_PRICES = {
    'tier-normal': 1200,
    'tier-sedang': 1500,
    'tier-tinggi': 1800,
};

export const TIER_LABELS = TTS_TIER_IDS.reduce((acc, id) => {
    acc[id] = (TTS_TIER_META[id] && TTS_TIER_META[id].label) || id;
    return acc;
}, {});

export const PRICE_MIN = 100;
export const PRICE_MAX = 2000000;
const PRICE_PREFIX = 'price:';

/** Kunci baris D1 untuk harga satu tier (mis. "price:tier-tinggi"). */
export function settingKey(tier) {
    return PRICE_PREFIX + tier;
}

/** Bulatkan & validasi harga; nilai tidak wajar dikembalikan sebagai fallback. */
export function sanitizePrice(value, fallback) {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n < PRICE_MIN || n > PRICE_MAX) return fallback;
    return n;
}

/**
 * Harga efektif per tier: nilai D1 menimpa default.
 * Kegagalan D1 (mis. tabel settings belum dimigrasi) TIDAK boleh memblokir analisa -> pakai default.
 */
export async function loadTierPrices(env) {
    const prices = { ...DEFAULT_TIER_PRICES };
    try {
        const rows = await getSettings(env.VO_DB);
        for (const row of rows) {
            if (!row || typeof row.key !== 'string' || row.key.indexOf(PRICE_PREFIX) !== 0) continue;
            const tier = row.key.slice(PRICE_PREFIX.length);
            if (!(tier in DEFAULT_TIER_PRICES)) continue;
            prices[tier] = sanitizePrice(row.value, DEFAULT_TIER_PRICES[tier]);
        }
    } catch (e) {
        console.error('Pricing read failed:', e && e.message ? e.message : String(e));
    }
    return prices;
}

/** Bentuk respons untuk UI: id netral + label + hint + harga (tanpa nama model). */
export function tierList(prices) {
    return TTS_TIER_IDS.map(id => ({
        id,
        label: TIER_LABELS[id],
        hint: (TTS_TIER_META[id] && TTS_TIER_META[id].hint) || '',
        price: prices[id],
    }));
}
