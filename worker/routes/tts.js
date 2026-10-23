// worker/routes/tts.js - Endpoint pratinjau suara Gemini TTS (butuh login, TANPA debit saldo).
import { Hono } from 'hono';
import { requireAuth } from '../lib/middleware.js';
import { GEMINI_TTS_VOICES, isKnownVoice, synthesizePreview } from '../lib/tts.js';

const router = new Hono();

const DEFAULT_SAMPLE = 'Halo sobat belanja! Ini contoh suara saya.';
const MAX_TEXT = 180; // batasi teks preview agar hemat kuota

/** GET /api/tts/voices - daftar 30 voice prebuilt (untuk mengisi pemilih di UI). */
router.get('/tts/voices', (c) => c.json({ voices: GEMINI_TTS_VOICES }));

/** POST /api/tts/preview {voiceName, text?} - hasilkan WAV cuplikan suara terpilih. Gratis, tanpa debit. */
router.post('/tts/preview', requireAuth, async (c) => {
    if (!c.env.GEMINI_API_KEY) {
        return c.json({ error: 'tts_unavailable', message: 'GEMINI_API_KEY belum diatur di server.' }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const voiceName = String(body.voiceName || '');
    if (!isKnownVoice(voiceName)) {
        return c.json({ error: 'voice_unknown', message: 'Nama voice tidak dikenal.' }, 400);
    }
    let text = String(body.text || DEFAULT_SAMPLE).trim().slice(0, MAX_TEXT);
    if (!text) text = DEFAULT_SAMPLE;
    const emotion = String(body.emotion || '').trim().slice(0, 40);

    try {
        const { wav } = await synthesizePreview(c.env, voiceName, text, emotion);
        return new Response(wav, {
            headers: {
                'Content-Type': 'audio/wav',
                'Content-Length': String(wav.length),
                'Cache-Control': 'no-store',
                'X-Voice': voiceName,
            },
        });
    } catch (e) {
        const s = e && e.status;
        if (s === 429) {
            return c.json({ error: 'tts_quota', message: 'Kuota gratis Gemini TTS hari ini habis (±10 permintaan/hari). Coba beberapa jam lagi, atau gunakan API key dengan billing aktif.' }, 429);
        }
        if (s === 401 || s === 403) {
            return c.json({ error: 'tts_key_invalid', message: 'GEMINI_API_KEY tidak valid / tidak punya akses TTS. Periksa kunci di server.' }, 502);
        }
        return c.json({ error: 'tts_failed', message: 'Pratinjau suara gagal' + (s ? ` (Gemini HTTP ${s})` : '') + ': ' + String(e.message || e) }, 502);
    }
});

export default router;
