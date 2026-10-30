// worker/lib/ai.js - Analisa frame video: Gemini (utama, free tier) dengan fallback AIVene qwen3.8-flash.
// Bentuk hasil final identik dengan kontrak UI lama: { research, scenes:[{start,end,emotion,text}], caption, hashtags }

import { ALLOWED_EMOTIONS } from './tts.js';

const AI_TIMEOUT_MS = 30000;      // per panggilan model (model *-lite bisa lambat utk banyak frame)
const AI_TOTAL_BUDGET_MS = 50000; // anggaran total lintas provider agar request tidak menggantung

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

/** Anggaran kata VO: Gemini TTS mengucapkan ~2,6 kata/detik pada tempo natural. */
export const WORD_BUDGET_PER_SECOND = 2.6;

/** Jumlah kata maksimum untuk satu jendela adegan (minimum 4 kata agar kalimat tetap utuh). */
export function wordBudgetForSeconds(sec) {
    const s = Math.max(0, Number(sec) || 0);
    return Math.max(4, Math.round(s * WORD_BUDGET_PER_SECOND));
}

/** Prompt analisa dalam Bahasa Indonesia: timestamp per adegan + emosi natural + CTA platform. */
export function buildAnalysisPrompt({ productName, affiliateLink, duration, gender, frameTimes, platform }) {
    const dur = Number(duration) || 15;
    const voice = gender === 'female' ? 'wanita' : 'pria';
    const cta = PLATFORM_CTA[platform] || PLATFORM_CTA.shopee;
    // Detik frame yang SEBENARNYA (dari ekstraksi di browser), bukan asumsi 1 frame = 1 detik:
    // tanpa ini model menaruh batas adegan di momen visual yang salah.
    const times = (frameTimes && frameTimes.length ? frameTimes : [0])
        .map(t => Math.round((Number(t) || 0) * 10) / 10);
    // Jendela antar frame + anggaran katanya: model memilih batas adegan dari daftar ini, sehingga
    // kalimat VO muat di waktunya dan tidak perlu dipotong/dipercepat berlebihan di sisi klien.
    const budgetLines = [];
    for (let i = 0; i < times.length; i++) {
        const start = times[i];
        const end = i < times.length - 1 ? times[i + 1] : dur;
        const span = end - start;
        if (span < 0.5) continue;
        budgetLines.push(`detik ${start.toFixed(1)}-${end.toFixed(1)} (${span.toFixed(1)} dtk) -> maksimal ${wordBudgetForSeconds(span)} kata`);
    }
    return [
        `Kamu adalah ahli copywriting affiliate video Indonesia untuk platform ${cta.label}.`,
        `Berikut ${times.length} frame video produk "${productName}" (durasi ${dur} detik):`,
        times.map((t, i) => `frame ${i + 1} = detik ke-${t.toFixed(1)}`).join('\n'),
        `Link affiliate: ${affiliateLink || '(kosong)'}`,
        `Analisa visual (termasuk teks yang tampil di layar) lalu hasilkan naskah Voice Over untuk suara ${voice}.`,
        `EMPAT TUGAS UTAMA:`,
        `1) TIMESTAMP: pecah durasi ${dur} detik menjadi 3-6 adegan BERURUTAN mengikuti perubahan adegan pada frame. Adegan pertama start=0; start tiap adegan = end adegan sebelumnya; adegan TERAKHIR wajib end=${dur}. Bila terlihat perubahan visual pada sebuah frame, pakai detik frame itu sebagai batas adegan - jangan mengarang batas di luar daftar frame di atas.`,
        `2) PANJANG KALIMAT (WAJIB): voice over tiap adegan harus MUAT di jendelanya. Anggaran kata per jendela waktu (kurang lebih 2,6 kata/detik):`,
        budgetLines.join('\n'),
        `Jangan melebihi anggaran kata pada jendela yang dipilih, dan jangan memotong CTA.`,
        `3) EMOSI PER ADEGAN (natural & terkurasi): nilai "emotion" tiap adegan WAJIB hanya dari: Penasaran, Prihatin, Terinspirasi, Yakin, Antusias, Terbukti, Mendesak, Ramah. Emosi HARUS menyesuaikan isi visual adegan itu secara natural (BUKAN urutan template kaku), dan DILARANG memakai label yang sama pada dua adegan berurutan. Susun busur affiliate longgar: buka dengan kait yang memancing (Penasaran/Prihatin), lanjut solusi & keyakinan (Yakin/Terinspirasi), bukti & kesaksian (Antusias/Terbukti), tutup ajakan (Mendesak/Ramah). Seluruh kalimat VO tetap berenergi positif dan meyakinkan.`,
        `4) CTA: ${cta.rule} Adegan TERAKHIR wajib memuat kalimat CTA ini, dan "caption" juga memuat CTA yang sama.`,
        `Balik HANYA JSON valid dengan skema:`,
        `{"research":"ringkasan riset produk 1-2 kalimat berbahasa Indonesia",`,
        `"scenes":[{"start":0,"end":5,"emotion":"Penasaran","text":"kalimat VO"}, ...lalu 3-6 adegan membagi ${dur} detik secara berurutan hingga adegan terakhir end=${dur}],`,
        `"caption":"caption promosi menarik berbahasa Indonesia, memuat CTA ${cta.label}",`,
        `"hashtags":"#Tag1 #Tag2 ... 5-8 hashtag relevan"}`,
        `Satu adegan = satu kalimat utuh (boleh maksimal dua kalimat pendek).`,
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

/** Petakan label emosi bebas ke kosakata terkurasi (case-insensitive + sinonim dekat). */
export function normalizeEmotion(raw) {
    const e = String(raw || '').trim();
    if (!e) return 'Antusias';
    const exact = ALLOWED_EMOTIONS.find(a => a.toLowerCase() === e.toLowerCase());
    if (exact) return exact;
    const s = e.toLowerCase();
    const table = [
        [['penasar', 'tanya', 'ingintahu'], 'Penasaran'],
        [['prihatin', 'sedih', 'murung', 'peduli', 'khawatir'], 'Prihatin'],
        [['inspirasi', 'semangat', 'termotivasi', 'bangga'], 'Terinspirasi'],
        [['yakin', 'meyakin', 'percaya', 'keyakin', 'optimis', 'hopeful'], 'Yakin'],
        [['antusias', 'senang', 'gembira', 'energi', 'seru', 'takjub', 'heran'], 'Antusias'],
        [['bukti', 'terbukti', 'kesaksian', 'nyata', 'hasil'], 'Terbukti'],
        [['desak', 'urgensi', 'segera', 'terbatas', 'tegas'], 'Mendesak'],
        [['ramah', 'hangat', 'akrab', 'santai'], 'Ramah'],
    ];
    for (const [keys, out] of table) { if (keys.some(k => s.includes(k))) return out; }
    return 'Antusias';
}

const MIN_SCENE_WINDOW_S = 1.2;   // di bawah ini adegan digabung ke tetangganya (satu kalimat per adegan)
const SNAP_TOLERANCE_S = 0.75;    // jarak maksimum batas adegan digeser ke detik frame nyata

/** Geser batas adegan ke detik frame terdekat agar potongan VO jatuh di perubahan visual. */
function snapToFrame(t, frameTimes) {
    let best = t;
    let bestDiff = SNAP_TOLERANCE_S;
    for (const ft of frameTimes || []) {
        const d = Math.abs(ft - t);
        if (d <= bestDiff) { best = ft; bestDiff = d; }
    }
    return Math.round(best * 10) / 10;
}

/** Validasi bentuk hasil; kembalikan objek ternormalisasi atau null. */
export function normalizeResult(raw, duration, options) {
    if (!raw || !Array.isArray(raw.scenes) || raw.scenes.length < 2 || raw.scenes.length > 6) return null;
    const dur = Math.max(1, Number(duration) || 15);
    // frameTimes hanya dipakai untuk menggeser batas adegan; tidak wajib ada (data lama/fallback).
    const frameTimes = (options && Array.isArray(options.frameTimes))
        ? options.frameTimes.map(Number).filter(t => Number.isFinite(t) && t >= 0 && t <= dur)
        : [];
    const items = raw.scenes.map((s) => ({
        end: Number(s.end),
        emotion: normalizeEmotion(s.emotion),
        text: String(s.text || '').trim(),
    })).filter(s => s.text);
    if (items.length < 2) return null;

    // Batas adegan: timestamp AI -> digeser ke frame nyata -> dipaksa naik & berurutan (kontigu).
    const cuts = [0];
    for (let i = 0; i < items.length - 1; i++) {
        const fallback = (dur * (i + 1)) / items.length;
        const rawEnd = Number.isFinite(items[i].end) && items[i].end > 0 ? items[i].end : fallback;
        cuts.push(snapToFrame(Math.min(dur, Math.max(0, rawEnd)), frameTimes));
    }
    cuts.push(Math.round(dur * 10) / 10);
    for (let i = 1; i < cuts.length; i++) {
        const min = i === cuts.length - 1 ? dur : cuts[i - 1] + MIN_SCENE_WINDOW_S;
        cuts[i] = Math.min(dur, Math.max(min, cuts[i]));
    }

    const scenes = [];
    for (let i = 0; i < items.length; i++) {
        const prev = scenes[scenes.length - 1];
        const scene = { start: cuts[i], end: cuts[i + 1], emotion: items[i].emotion, text: items[i].text };
        // Adegan yang terlalu pendek digabung ke adegan sebelumnya: satu kalimat per adegan.
        if (prev && scene.end - scene.start < MIN_SCENE_WINDOW_S) {
            prev.end = scene.end;
            prev.text = (prev.text + ' ' + scene.text).trim();
            continue;
        }
        scenes.push(scene);
    }
    if (scenes.length < 2) return null;
    scenes[0].start = 0;
    scenes[scenes.length - 1].end = dur; // adegan terakhir menutup tepat di akhir durasi
    return {
        research: String(raw.research || '').trim(),
        scenes,
        caption: String(raw.caption || '').trim(),
        hashtags: String(raw.hashtags || '').trim(),
    };
}

/** Panggil Gemini generateContent dengan frame sebagai inlineData. Lempar jika HTTP bukan 2xx. */
async function callGemini(env, model, frames, prompt, timeoutMs) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const parts = frames.map(f => {
        const parsed = splitDataUrl(f);
        return parsed ? { inlineData: { mimeType: parsed.mimeType, data: parsed.data } } : null;
    }).filter(Boolean);
    parts.push({ text: prompt });

    // Model Gemini 3.x non-lite memakai "thinking" yang menghabiskan jatah token
    // sebelum menulis jawaban -> JSON terpotong (finish=MAX_TOKENS). Matikan thinking
    // via thinkingBudget=0 agar token tersedia untuk output. Model *-lite tidak mendukung
    // thinkingConfig (menolak 400), jadi hanya sisipkan untuk model non-lite.
    const generationConfig = {
        responseMimeType: 'application/json',
        maxOutputTokens: 2048,
        temperature: 0.8,
    };
    if (!/lite/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig,
        }),
        signal: AbortSignal.timeout(timeoutMs || AI_TIMEOUT_MS),
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
async function callAivene(env, frames, prompt, timeoutMs) {
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
        signal: AbortSignal.timeout(timeoutMs || AI_TIMEOUT_MS),
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

/** Detik tiap frame: pakai yang dikirim browser, atau titik tengah interval sampel sebagai fallback. */
function normalizeFrameTimes(frameTimes, count, duration) {
    const dur = Math.max(1, Number(duration) || 15);
    const src = Array.isArray(frameTimes) ? frameTimes : [];
    const out = [];
    for (let i = 0; i < count; i++) {
        const t = Number(src[i]);
        const fallback = +(((i + 0.5) * dur) / Math.max(1, count)).toFixed(1);
        out.push(Number.isFinite(t) && t >= 0 && t <= dur ? Math.round(t * 10) / 10 : fallback);
    }
    return out;
}

/**
 * Router utama: coba SEMUA model Gemini berurutan (mutu -> murah) agar hemat free tier;
 * baru jatuh ke AIVene setelah seluruh Gemini gagal (mis. 429 kuota harian).
 * Mengembalikan { result, provider } atau melempar Error jika semuanya gagal.
 */
export async function analyzeVideo(env, { frames, frameTimes, productName, affiliateLink, duration, gender, platform }) {
    const dur = Number(duration) || 15;
    const times = normalizeFrameTimes(frameTimes, frames.length, dur);
    const prompt = buildAnalysisPrompt({ productName, affiliateLink, duration: dur, gender, frameTimes: times, platform });
    const fallbackEnabled = String(env.GEMINI_FALLBACK_ENABLED ?? 'true') !== 'false';
    const models = String(env.GEMINI_MODELS || env.GEMINI_MODEL || 'gemini-3.5-flash')
        .split(',').map(s => s.trim()).filter(Boolean);
    const errors = [];
    const deadline = Date.now() + AI_TOTAL_BUDGET_MS;
    const remaining = () => deadline - Date.now();

    if (env.GEMINI_API_KEY) {
        for (const model of models) {
            if (remaining() < 3000) { errors.push(`${model}: dilewati (waktu habis)`); break; }
            try {
                const raw = await callGemini(env, model, frames, prompt, Math.min(AI_TIMEOUT_MS, remaining()));
                const result = normalizeResult(raw, dur, { frameTimes: times });
                if (result) return { result, provider: 'gemini:' + model };
                errors.push(`${model}: JSON tidak valid`);
            } catch (e) {
                errors.push(`${model}: ${e.message}`); // 429/503/timeout -> coba model berikutnya
            }
        }
    } else {
        errors.push('GEMINI_API_KEY kosong');
    }

    if (fallbackEnabled && env.AIVENE_API_KEY && remaining() > 3000) {
        try {
            const raw = await callAivene(env, frames, prompt, Math.min(AI_TIMEOUT_MS, remaining()));
            const result = normalizeResult(raw, dur, { frameTimes: times });
            if (result) return { result, provider: 'aivene' };
            errors.push('aivene: JSON tidak valid');
        } catch (e) {
            errors.push(`aivene: ${e.message}`); // seluruh provider gagal -> lempar
        }
    }
    throw new Error(errors.join(' | ') || 'Analisa AI gagal');
}
