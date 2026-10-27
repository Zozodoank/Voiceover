// worker/routes/tts.js - Endpoint pratinjau/sintesis suara VO: Gemini TTS (pilih model per tier kualitas).
// Butuh login, TANPA debit saldo. Audio identik (tier+voice+emosi+teks) disimpan di KV agar
// pemutaran ulang / ekspor ulang tidak memanggil Gemini lagi (hemat kuota TTS free tier).
import { Hono } from 'hono';
import { requireAuth } from '../lib/middleware.js';
import { listVoices, isKnownVoice, isKnownTier, synthesizeVoice, TTS_MAX_TEXT } from '../lib/tts.js';

const router = new Hono();

const DEFAULT_SAMPLE = 'Halo sobat belanja! Ini contoh suara saya.';
const TTS_CACHE_TTL = 60 * 60 * 24 * 30; // 30 hari

/** Hash SHA-256 (hex, 32 karakter) - kunci cache tanpa menyimpan naskah user di KV. */
async function hashText(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex.slice(0, 32);
}

function degradeEnabled(env) {
    return String(env.TTS_ALLOW_DEGRADE || 'false').toLowerCase() === 'true';
}

/** GET /api/tts/voices - daftar voice TTS aktif untuk pemilih di UI (tanpa nama model/engine). */
router.get('/tts/voices', (c) => c.json({ voices: listVoices(c.env) }));

/** POST /api/tts/preview {voiceName, text?, emotion?, tier?} - audio adegan (WAV). */
router.post('/tts/preview', requireAuth, async (c) => {
    if (!c.env.GEMINI_API_KEY && !(c.env.AIVENE_API_KEY && degradeEnabled(c.env))) {
        return c.json({ error: 'tts_unavailable', message: 'GEMINI_API_KEY belum diatur di server.' }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const voiceName = String(body.voiceName || '');
    if (!isKnownVoice(c.env, voiceName)) {
        return c.json({ error: 'voice_unknown', message: 'Nama voice tidak dikenal.' }, 400);
    }
    let text = String(body.text || DEFAULT_SAMPLE).trim();
    if (!text) text = DEFAULT_SAMPLE;
    // Teks panjang DITOLAK, bukan dipotong diam-diam: audio harus sepanjang teks subtitle.
    if (text.length > TTS_MAX_TEXT) {
        return c.json({
            error: 'text_too_long',
            message: `Teks adegan terlalu panjang (${text.length}/${TTS_MAX_TEXT} karakter).`,
        }, 400);
    }
    const emotion = String(body.emotion || '').trim().slice(0, 40);
    const tier = isKnownTier(body.tier) ? String(body.tier) : 'tier-normal';

    const cacheKey = `tts:v1:${tier}:${voiceName}:${emotion || '-'}:${await hashText(text)}`;
    try {
        const hit = await c.env.ORDERS.getWithMetadata(cacheKey, 'arrayBuffer');
        if (hit && hit.value && hit.value.byteLength) {
            return new Response(hit.value, {
                headers: {
                    'Content-Type': (hit.metadata && hit.metadata.contentType) || 'audio/wav',
                    'Content-Length': String(hit.value.byteLength),
                    'Cache-Control': 'no-store',
                    'X-Voice': voiceName,
                    'X-Tts-Cache': 'hit',
                    'X-Tts-Provider': (hit.metadata && hit.metadata.provider) || 'gemini',
                    'X-Tts-Tier': tier,
                },
            });
        }
    } catch (e) {
        // Cache hanya optimasi: kegagalan baca tidak boleh menggagalkan sintesis.
        console.error('TTS cache read failed:', e && e.message ? e.message : String(e));
    }

    try {
        const { bytes, contentType, provider } = await synthesizeVoice(c.env, { text, voiceName, emotion, tier });
        try {
            await c.env.ORDERS.put(cacheKey, bytes, {
                metadata: { contentType, provider: provider || 'gemini' },
                expirationTtl: TTS_CACHE_TTL,
            });
        } catch (e) {
            console.error('TTS cache write failed:', e && e.message ? e.message : String(e));
        }
        return new Response(bytes, {
            headers: {
                'Content-Type': contentType,
                'Content-Length': String(bytes.byteLength),
                'Cache-Control': 'no-store',
                'X-Voice': voiceName,
                'X-Tts-Cache': 'miss',
                'X-Tts-Provider': provider || '',
                'X-Tts-Tier': tier,
            },
        });
    } catch (e) {
        const s = e && e.status;
        if (s === 401) return c.json({ error: 'tts_key_invalid', message: 'Kunci API TTS tidak valid.' }, 502);
        if (s === 402) return c.json({ error: 'tts_billing', message: 'Kredit TTS habis atau kena limit belanja.' }, 502);
        if (s === 403) return c.json({ error: 'tts_forbidden', message: 'Kunci API tidak punya akses model TTS ini.' }, 502);
        if (s === 429) {
            return c.json({ error: 'tts_rate', message: 'Kuota TTS sedang penuh, coba lagi beberapa saat.' }, 429, {
                'Retry-After': '5',
            });
        }
        return c.json({ error: 'tts_failed', message: 'Suara gagal dibuat. Coba lagi beberapa saat.' }, 502);
    }
});

export default router;
