// worker/lib/ai.js - Analisa frame video: Gemini (utama, free tier) dengan fallback AIVene qwen3.8-flash.
// Bentuk hasil final identik dengan kontrak UI lama: { research, scenes:[{start,end,emotion,text}], caption, hashtags }

const AI_TIMEOUT_MS = 20000;

/** Aturan CTA per platform tujuan - menentukan frasa keranjang yang boleh/tidak boleh. */
const PLATFORM_CTA = {
    shopee: {
        label: 'Shopee Video',
        rule: 'CTA: akhiri naskah dengan ajakan klik KERANJANG ORANGE (mis. "klik keranjang orange sekarang, stok terbatas!"). DILARANG menyebut "keranjang kuning".',
    },
    tiktok: {
        label: 'TikTok',
        rule: 'CTA: akhiri naskah dengan ajakan KERANJANG KUNING (mis. "cek keranjang kuning di bawah ya!"). DILARANG menyebut "keranjang orange".',
    },
    reels: {
        label: 'Instagram Reels',
        rule: 'CTA BEBAS dan bervariasi (mis. "klik link di bio", "simpan video ini", "share ke teman", "komen minat buat link"). DILARANG menyebut keranjang kuning/orange.',
    },
    youtube: {
        label: 'YouTube Shorts',
        rule: 'CTA BEBAS dan bervariasi (mis. "subscribe & nyalakan lonceng", "klik link di deskripsi", "tonton sampai habis"). DILARANG menyebut keranjang kuning/orange.',
    },
};

/** Prompt analisa dalam Bahasa Indonesia: timestamp per adegan + emosi natural + CTA platform. */
export function buildAnalysisPrompt({ productName, affiliateLink, duration, gender, frameTimes, platform }) {
    const dur = Number(duration) || 15;
    const voice = gender === 'female' ? 'wanita' : 'pria';
    const cta = PLATFORM_CTA[platform] || PLATFORM_CTA.shopee;
    return [
        `Kamu adalah ahli copywriting affiliate video Indonesia untuk platform ${cta.label}.`,
        `Berikut ${frameTimes.length} frame video produk "${productName}" (durasi ${dur} detik):`,
        frameTimes.map((t, i) => `frame ${i + 1} = detik ke-${t}`).join('\n'),
        `Link affiliate: ${affiliateLink || '(kosong)'}`,
        `Analisa visual (termasuk teks yang tampil di layar) lalu hasilkan naskah Voice Over untuk suara ${voice}.`,
        `TIGA TUGAS UTAMA:`,
        `1) TIMESTAMP: pecah durasi ${dur} detik menjadi 3-6 adegan BERURUTAN mengikuti perubahan adegan pada frame. Adegan pertama start=0; start tiap adegan = end adegan sebelumnya; adegan TERAKHIR wajib end=${dur}.`,
        `2) EMOSI NATURAL: isi "emotion" tiap adegan HARUS wajar mengikuti isi visual adegan itu (mis. Penasaran, Prihatin, Heran, Hopeful, Yakin, Antusias, Mendesak), mengalir seperti narator sungguhan - BUKAN pola kaku yang diulang.`,
        `3) CTA: ${cta.rule} Adegan TERAKHIR wajib memuat kalimat CTA ini, dan "caption" juga memuat CTA yang sama.`,
        `Balik HANYA JSON valid dengan skema:`,
        `{"research":"ringkasan riset produk 1-2 kalimat berbahasa Indonesia",`,
        `"scenes":[{"start":0,"end":5,"emotion":"Penasaran","text":"kalimat VO"}, ...lalu 3-6 adegan membagi ${dur} detik secara berurutan hingga adegan terakhir end=${dur}],`,
        `"caption":"caption promosi menarik berbahasa Indonesia, memuat CTA ${cta.label}",`,
        `"hashtags":"#Tag1 #Tag2 ... 5-8 hashtag relevan"}`,
        `Maksimal 20 kata per kalimat VO.`,
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
    scenes[scenes.length - 1].end = dur; // pastikan adegan terakhir menutup tepat di akhir durasi
    return {
        research: String(raw.research || '').trim(),
        scenes,
        caption: String(raw.caption || '').trim(),
        hashtags: String(raw.hashtags || '').trim(),
    };
}

/** Panggil Gemini generateContent dengan frame sebagai inlineData. Lempar jika HTTP bukan 2xx. */
async function callGemini(env, model, frames, prompt) {
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
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 700, temperature: 0.8 },
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
            max_tokens: 700,
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
 * Router utama: coba SEMUA model Gemini berurutan (mutu -> murah) agar hemat free tier;
 * baru jatuh ke AIVene setelah seluruh Gemini gagal (mis. 429 kuota harian).
 * Mengembalikan { result, provider } atau melempar Error jika semuanya gagal.
 */
export async function analyzeVideo(env, { frames, productName, affiliateLink, duration, gender, platform }) {
    const frameTimes = frames.map((_, i) => i);
    const prompt = buildAnalysisPrompt({ productName, affiliateLink, duration, gender, frameTimes, platform });
    const fallbackEnabled = String(env.GEMINI_FALLBACK_ENABLED ?? 'true') !== 'false';
    const models = String(env.GEMINI_MODELS || env.GEMINI_MODEL || 'gemini-2.5-flash')
        .split(',').map(s => s.trim()).filter(Boolean);
    let lastError = null;

    if (env.GEMINI_API_KEY) {
        for (const model of models) {
            try {
                const raw = await callGemini(env, model, frames, prompt);
                const result = normalizeResult(raw, duration);
                if (result) return { result, provider: 'gemini:' + model };
                lastError = new Error(`Respons ${model} tidak dapat diparse jadi JSON valid`);
            } catch (e) {
                lastError = e; // 429/5xx/timeout -> coba model Gemini berikutnya
            }
        }
    } else {
        lastError = new Error('GEMINI_API_KEY kosong');
    }

    if (fallbackEnabled && env.AIVENE_API_KEY) {
        try {
            const raw = await callAivene(env, frames, prompt);
            const result = normalizeResult(raw, duration);
            if (result) return { result, provider: 'aivene' };
        } catch (e) {
            lastError = e; // seluruh Gemini + AIVene gagal -> lempar
        }
    }
    throw lastError || new Error('Analisa AI gagal');
}
