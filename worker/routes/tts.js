// worker/routes/tts.js - Endpoint pratinjau/sintesis suara VO: Gemini TTS utama, fallback AIVene
// (butuh login, TANPA debit saldo).
import { Hono } from 'hono';
import { requireAuth } from '../lib/middleware.js';
import { listVoices, isKnownVoice, synthesizeVoice } from '../lib/tts.js';

const router = new Hono();

const DEFAULT_SAMPLE = 'Halo sobat belanja! Ini contoh suara saya.';
const MAX_TEXT = 200; // batasi teks agar hemat (AIVene ditagih per detik audio; Gemini ada kuota)

/** GET /api/tts/voices - daftar voice TTS aktif (Gemini) untuk mengisi pemilih di UI. */
router.get('/tts/voices', (c) => c.json({
    provider: 'gemini',
    model: c.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
    voices: listVoices(c.env),
}));

/** POST /api/tts/preview {voiceName, text?, emotion?, tier?} - hasilkan audio (Gemini -> fallback AIVene). */
router.post('/tts/preview', requireAuth, async (c) => {
    if (!c.env.GEMINI_API_KEY && !c.env.AIVENE_API_KEY) {
        return c.json({ error: 'tts_unavailable', message: 'GEMINI_API_KEY/AIVENE_API_KEY belum diatur di server.' }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const voiceName = String(body.voiceName || '');
    if (!isKnownVoice(c.env, voiceName)) {
        return c.json({ error: 'voice_unknown', message: 'Nama voice tidak dikenal.' }, 400);
    }
    let text = String(body.text || DEFAULT_SAMPLE).trim().slice(0, MAX_TEXT);
    if (!text) text = DEFAULT_SAMPLE;
    const emotion = String(body.emotion || '').trim().slice(0, 40);
    const tier = String(body.tier || '').trim().slice(0, 40);

    try {
        const { bytes, contentType, provider } = await synthesizeVoice(c.env, { text, voiceName, emotion, tier });
        return new Response(bytes, {
            headers: {
                'Content-Type': contentType,
                'Content-Length': String(bytes.byteLength),
                'Cache-Control': 'no-store',
                'X-Voice': voiceName,
                'X-Tts-Provider': provider || '',
            },
        });
    } catch (e) {
        const s = e && e.status;
        if (s === 401) return c.json({ error: 'tts_key_invalid', message: 'Kunci API TTS tidak valid.' }, 502);
        if (s === 402) return c.json({ error: 'tts_billing', message: 'Saldo/kredit AIVene habis atau kena limit belanja.' }, 502);
        if (s === 403) return c.json({ error: 'tts_forbidden', message: 'Kunci API tidak punya akses model TTS ini.' }, 502);
        if (s === 429) return c.json({ error: 'tts_rate', message: 'Rate limit TTS terlampaui, coba lagi sebentar.' }, 429);
        return c.json({ error: 'tts_failed', message: 'Pratinjau suara gagal' + (s ? ` (HTTP ${s})` : '') + ': ' + String(e.message || e) }, 502);
    }
});

export default router;
