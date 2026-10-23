// worker/routes/tts.js - Endpoint pratinjau suara TTS via AIVene (butuh login, TANPA debit saldo).
import { Hono } from 'hono';
import { requireAuth } from '../lib/middleware.js';
import { listVoices, isKnownVoice, synthesizePreview } from '../lib/tts.js';

const router = new Hono();

const DEFAULT_SAMPLE = 'Halo sobat belanja! Ini contoh suara saya.';
const MAX_TEXT = 180; // batasi teks preview agar hemat (AIVene ditagih per detik audio)

/** GET /api/tts/voices - daftar voice TTS aktif (AIVene) untuk mengisi pemilih di UI. */
router.get('/tts/voices', (c) => c.json({
    provider: 'aivene',
    model: c.env.AIVENE_TTS_MODEL || 'tts-1',
    voices: listVoices(c.env),
}));

/** POST /api/tts/preview {voiceName, text?, emotion?} - hasilkan audio cuplikan suara terpilih. Tanpa debit. */
router.post('/tts/preview', requireAuth, async (c) => {
    if (!c.env.AIVENE_API_KEY) {
        return c.json({ error: 'tts_unavailable', message: 'AIVENE_API_KEY belum diatur di server.' }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const voiceName = String(body.voiceName || '');
    if (!isKnownVoice(c.env, voiceName)) {
        return c.json({ error: 'voice_unknown', message: 'Nama voice tidak dikenal.' }, 400);
    }
    let text = String(body.text || DEFAULT_SAMPLE).trim().slice(0, MAX_TEXT);
    if (!text) text = DEFAULT_SAMPLE;
    const emotion = String(body.emotion || '').trim().slice(0, 40);

    try {
        const { bytes, contentType } = await synthesizePreview(c.env, voiceName, text, emotion);
        return new Response(bytes, {
            headers: {
                'Content-Type': contentType,
                'Content-Length': String(bytes.byteLength),
                'Cache-Control': 'no-store',
                'X-Voice': voiceName,
            },
        });
    } catch (e) {
        const s = e && e.status;
        if (s === 401) return c.json({ error: 'tts_key_invalid', message: 'AIVENE_API_KEY tidak valid.' }, 502);
        if (s === 402) return c.json({ error: 'tts_billing', message: 'Saldo/kredit AIVene habis atau kena limit belanja.' }, 502);
        if (s === 403) return c.json({ error: 'tts_forbidden', message: 'Key AIVene tidak punya akses model TTS ini.' }, 502);
        if (s === 429) return c.json({ error: 'tts_rate', message: 'Rate limit AIVene terlampaui, coba lagi sebentar.' }, 429);
        return c.json({ error: 'tts_failed', message: 'Pratinjau suara gagal' + (s ? ` (AIVene HTTP ${s})` : '') + ': ' + String(e.message || e) }, 502);
    }
});

export default router;
