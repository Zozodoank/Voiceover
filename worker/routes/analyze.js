// worker/routes/analyze.js - POST /api/analyze: analisa frame video oleh AI (auth + gerbang credit)
import { Hono } from 'hono';
import { requireAuth } from '../lib/middleware.js';
import { getUser, tryDeductBalance, countGeneration } from '../lib/db.js';
import { analyzeVideo } from '../lib/ai.js';
import { getVoice } from '../lib/tts.js';

const router = new Hono();

// Harga per generasi - SINKRON dengan atribut data-price pada radio ttsModel di app.html
const PRICES = {
    'gemini-tts-flash-3.1': 1200,
    'gemini-tts-flash-3.7': 1500,
    'gemini-tts-flash-3.8': 1800,
};

const MAX_FRAMES = 16;
const MAX_FRAME_BYTES = 200 * 1024; // per frame (base64 dataUrl)
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

router.post('/analyze', requireAuth, async (c) => {
    const session = c.get('session');
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.frames) || body.frames.length === 0) {
        return c.json({ error: 'Frame video wajib disertakan' }, 400);
    }

    // Validasi payload di edge sebelum meneruskan ke AI
    const frames = body.frames.filter(f => typeof f === 'string' && f.startsWith('data:image/jpeg;base64,'));
    if (frames.length === 0 || frames.length > MAX_FRAMES) {
        return c.json({ error: `Jumlah frame tidak valid (1-${MAX_FRAMES} JPEG)` }, 400);
    }
    let total = 0;
    for (const f of frames) {
        if (f.length > MAX_FRAME_BYTES) return c.json({ error: 'Ada frame yang terlalu besar (>200KB)' }, 400);
        total += f.length;
    }
    if (total > MAX_TOTAL_BYTES) return c.json({ error: 'Total payload frame terlalu besar (>4MB)' }, 400);

    const productName = String(body.productName || '').trim();
    if (!productName) return c.json({ error: 'Nama produk wajib diisi' }, 400);

    const platform = ['shopee', 'tiktok', 'reels', 'youtube'].includes(body.platform) ? body.platform : 'shopee';

    // Voice terpilih menentukan gender nada naskah (fallback ke body.gender bila voice tak dikenal)
    const voiceName = typeof body.voiceName === 'string' ? body.voiceName : '';
    const voice = getVoice(voiceName);
    const gender = voice ? voice.gender : (body.gender === 'female' ? 'female' : 'male');

    const price = PRICES[body.modelValue] != null ? PRICES[body.modelValue] : 1200;
    const unlimited = !!session.unlimited;

    // Gerbang credit (superadmin tanpa batas) - debit baru terjadi SETELAH AI sukses
    if (!unlimited) {
        const user = await getUser(c.env.VO_DB, session.email);
        if (!user || user.balance < price) {
            return c.json({ error: 'insufficient', need: price, have: user ? user.balance : 0 }, 402);
        }
    }

    let analyzed;
    try {
        analyzed = await analyzeVideo(c.env, {
            frames,
            productName,
            affiliateLink: String(body.affiliateLink || ''),
            duration: Number(body.duration) || 15,
            gender,
            platform,
            voiceName,
        });
    } catch (e) {
        // Dua provider gagal: jangan debit apa pun
        return c.json({ error: 'ai_unavailable', message: 'Analisa AI gagal dicoba ulang nanti. Detail: ' + String(e.message || e) }, 502);
    }

    if (unlimited) {
        await countGeneration(c.env.VO_DB, session.email);
        return c.json({ result: analyzed.result, provider: analyzed.provider, balance: null, unlimited: true });
    }

    const deducted = await tryDeductBalance(c.env.VO_DB, session.email, price);
    if (!deducted) {
        // saldo habis di tengah jalan (race) - minta top up, hasil AI dibuang
        const user = await getUser(c.env.VO_DB, session.email);
        return c.json({ error: 'insufficient', need: price, have: user ? user.balance : 0 }, 402);
    }
    const user = await getUser(c.env.VO_DB, session.email);
    return c.json({ result: analyzed.result, provider: analyzed.provider, balance: user.balance, unlimited: false });
});

export default router;
