// worker/lib/ai.js - Analisa frame video: Gemini (utama, free tier) dengan fallback AIVene qwen3.8-flash.
// Bentuk hasil final identik dengan kontrak UI lama: { research, scenes:[{start,end,emotion,text}], caption, hashtags }

const AI_TIMEOUT_MS = 20000;

/** Prompt analisa dalam Bahasa Indonesia, minta JSON terstruktur. */
export function buildAnalysisPrompt({ productName, affiliateLink, duration, gender, frameTimes }) {
    const dur = Number(duration) || 15;
    const voice = gender === 'female' ? 'wanita' : 'pria';
    return [
        `Kamu adalah ahli copywriting affiliate TikTok/Shopee Video Indonesia.`,
        `Berikut ${frameTimes.length} frame video produk "${productName}" (durasi ${dur} detik) yang diambil per detik:`,
        frameTimes.map((t, i) => `frame ${i + 1} = detik ke-${t}`).join('\n'),
        `Link affiliate: ${affiliateLink || '(kosong)'}`,
        `Tugas: analisa visual (termasuk teks yang tampil di layar) lalu hasilkan naskah Voice Over untuk suara ${voice}.`,
        `Balik HANYA JSON valid dengan skema:`,
        `{"research":"ringkasan riset produk 1-2 kalimat berbahasa Indonesia",`,
        `"scenes":[{"start":0,"end":5,"emotion":"Prihatin / Penasaran (Hook)","text":"kalimat VO"}, ...3-5 adegan membagi durasi ${dur} detik secara berurutan],`,
        `"caption":"caption promosi menarik berbahasa Indonesia",`,
        `"hashtags":"#Tag1 #Tag2 ... 5-8 hashtag relevan"}`,
        `Setiap adegan WAJIB punya pola emosi berbeda (hook, solusi/informatif, desakan CTA). Maksimal 20 kata per kalimat VO.`,
    ].join('\n');
}

/** Ubah dataUrl "data:image/jpeg;base64,..." menjadi { mimeType, data }. */
function splitDataUrl(dataUrl) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
    if (!m) return null;
    return { mimeType: m[1], data: m[2] };
}

function extractJson(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { /* coba cari blok JSON */ }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) { return null; } }
    return null;
}

/** Validasi bentuk hasil; kembalikan objek ternormalisasi atau null. */
export function normalizeResult(raw, duration) {
    if (!raw || !Array.isArray(raw.scenes) || raw.scenes.length < 2 || raw.scenes.length > 6) return null;
    const dur = Number(duration) || 15;
    const scenes = raw.scenes.map((s, i) => ({
        start: Math.max(0, Math.round(Number(s.start) >= 0 ? Number(s.start) : Math.floor((i * dur) / raw.scenes.length))),
        end: Math.max(1, Math.round(Number(s.end) > 0 ? Number(s.end) : Math.floor(((i + 1) * dur) / raw.scenes.length))),
        emotion: String(s.emotion || 'Netral'),
        text: String(s.text || '').trim(),
    })).filter(s => s.text);
    if (scenes.length < 2) return null;
    return {
        research: String(raw.research || '').trim(),
        scenes,
        caption: String(raw.caption || '').trim(),
        hashtags: String(raw.hashtags || '').trim(),
    };
}

/** Panggil Gemini generateContent dengan frame sebagai inlineData. Lempar jika HTTP bukan 2xx. */
async function callGemini(env, frames, prompt) {
    const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const parts = frames.map(f => {
        const parsed = splitDataUrl(f);
        return parsed ? { inlineData: { mimeType: parsed.mimeType, data: parsed.data } } : null;
    }).filter(Boolean);
    parts.push({ text: prompt });

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2048, temperature: 0.8 },
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) {
        const err = new Error(`Gemini HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    return extractJson(text);
}

/** Fallback: AIVene endpoint OpenAI-compatible (model qwen3.8-flash) dengan image_url base64. */
async function callAivene(env, frames, prompt) {
    const base = String(env.AIVENE_BASE_URL || 'https://aivene.com/v1beta').replace(/\/$/, '');
    const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    const content = frames.map(f => ({ type: 'image_url', image_url: { url: f } }));
    content.push({ type: 'text', text: prompt });

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AIVENE_API_KEY}` },
        body: JSON.stringify({
            model: env.AIVENE_MODEL || 'qwen3.8-flash',
            messages: [{ role: 'user', content }],
            temperature: 0.8,
            max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) {
        const err = new Error(`AIVene HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return extractJson(text);
}

/**
 * Router utama: coba Gemini dulu; saat 429/5xx/error/timeout dan fallback aktif -> AIVene.
 * Mengembalikan { result, provider } atau melempar Error jika keduanya gagal.
 */
export async function analyzeVideo(env, { frames, productName, affiliateLink, duration, gender }) {
    const frameTimes = frames.map((_, i) => i);
    const prompt = buildAnalysisPrompt({ productName, affiliateLink, duration, gender, frameTimes });
    const fallbackEnabled = String(env.GEMINI_FALLBACK_ENABLED ?? 'true') !== 'false';
    let firstError = null;

    try {
        if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY kosong');
        const raw = await callGemini(env, frames, prompt);
        const result = normalizeResult(raw, duration);
        if (result) return { result, provider: 'gemini' };
        firstError = new Error('Respons Gemini tidak dapat diparse jadi JSON valid');
    } catch (e) {
        firstError = e;
    }

    if (fallbackEnabled && env.AIVENE_API_KEY) {
        try {
            const raw = await callAivene(env, frames, prompt);
            const result = normalizeResult(raw, duration);
            if (result) return { result, provider: 'aivene' };
        } catch (e) {
            // dua-duanya gagal -> lempar error gabungan
        }
    }
    throw firstError || new Error('Analisa AI gagal');
}
