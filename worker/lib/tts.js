// worker/lib/tts.js - Sintesis suara VO: Gemini TTS (utama) dengan rantai model per tier kualitas.
// Gemini TTS: POST generateContent responseModalities=AUDIO -> PCM (audio/L16) ATAU container audio/wav
// siap pakai (mis. model 3.8). AIVene hanya dipakai bila TTS_ALLOW_DEGRADE="true" (default MATI)
// agar kualitas tidak pernah turun diam-diam ke voice robotik.

const TTS_TIMEOUT_DEFAULT_MS = 30000;
const AIVENE_TTS_TIMEOUT_MS = 12000;
const TTS_RETRY_DELAYS_MS = [800, 1600, 3200];

// Tier kualitas memakai id NETRAL: nama model tidak boleh muncul di frontend.
export const TTS_TIER_IDS = ['tier-normal', 'tier-sedang', 'tier-tinggi'];

export const TTS_TIER_META = {
    'tier-normal': { label: 'Normal', hint: 'Standar' },
    'tier-sedang': { label: 'Sedang', hint: 'Ekspresif' },
    'tier-tinggi': { label: 'Tinggi', hint: 'Premium' },
};

// Normal -> 2.5 Flash TTS, Sedang -> 3.1 Flash TTS, Tinggi -> 3.8 Flash TTS (fallback 3.1).
const DEFAULT_TIER_MODEL = {
    'tier-normal': 'gemini-2.5-flash-preview-tts',
    'tier-sedang': 'gemini-3.1-flash-tts-preview',
    'tier-tinggi': 'gemini-3.8-flash-tts',
};

const TIER_MODEL_ENV = {
    'tier-normal': 'TTS_MODEL_NORMAL',
    'tier-sedang': 'TTS_MODEL_SEDANG',
    'tier-tinggi': 'TTS_MODEL_TINGGI',
};

// Batas teks TTS: cukup untuk satu adegan utuh. Teks lebih panjang DITOLAK, bukan dipotong
// diam-diam (pemotongan membuat audio lebih pendek dari subtitle = desync).
export const TTS_MAX_TEXT = 1500;

/** True bila id tier dikenal frontend/worker. */
export function isKnownTier(tier) {
    return TTS_TIER_IDS.includes(String(tier || ''));
}

/** Rantai model untuk satu tier: model utama + fallback (env TTS_FALLBACK_ORDER, pisahkan koma). */
export function tierModels(env, tier) {
    const key = TIER_MODEL_ENV[tier];
    const primary = (key && env && env[key]) || DEFAULT_TIER_MODEL[tier] || DEFAULT_TIER_MODEL['tier-normal'];
    const extra = String((env && env.TTS_FALLBACK_ORDER) || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    return [...new Set([primary, ...extra])];
}

function ttsTimeout(env) {
    const n = Number(env && env.TTS_TIMEOUT_MS);
    return Number.isFinite(n) && n >= 5000 ? n : TTS_TIMEOUT_DEFAULT_MS;
}

/** Anggaran waktu total satu permintaan TTS (semua model fallback). */
function chainBudget(env) {
    const n = Number(env && env.TTS_CHAIN_BUDGET_MS);
    return Number.isFinite(n) && n >= 5000 ? n : 60000;
}

// Daftar voice resmi Gemini TTS (subset kurasi + trait/gender perkiraan untuk UI & nada naskah).
// Override lewat env GEMINI_TTS_VOICES = "Kore,Puck,..." bila katalog Anda beda.
const GEMINI_VOICES = [
    { name: 'Kore',        trait: 'Jernih & tenang',   gender: 'female' },
    { name: 'Zephyr',      trait: 'Ceria & cerah',     gender: 'female' },
    { name: 'Puck',        trait: 'Riang & upbeat',    gender: 'male' },
    { name: 'Charon',      trait: 'Tegas & informatif', gender: 'male' },
    { name: 'Fenrir',      trait: 'Bersemangat',       gender: 'male' },
    { name: 'Leda',        trait: 'Muda & segar',      gender: 'female' },
    { name: 'Orus',        trait: 'Kokoh & tegas',     gender: 'male' },
    { name: 'Aoede',       trait: 'Ringan & breezy',   gender: 'female' },
    { name: 'Enceladus',   trait: 'Halus & breathy',   gender: 'male' },
    { name: 'Algieba',     trait: 'Mulus & hangat',    gender: 'male' },
    { name: 'Despoina',    trait: 'Memikat & catchy',  gender: 'female' },
    { name: 'Erato',       trait: 'Antusias & hidup',  gender: 'female' },
    { name: 'Metis',       trait: 'Bijak & thoughtul', gender: 'female' },
    { name: 'Hippolytos',  trait: 'Energik & kuat',    gender: 'male' },
];

/** Daftar voice aktif: dari env GEMINI_TTS_VOICES (nama dipisah koma) atau default resmi. */
export function listVoices(env) {
    const raw = String((env && env.GEMINI_TTS_VOICES) || '').trim();
    if (!raw) return GEMINI_VOICES;
    return raw.split(',').map(s => s.trim()).filter(Boolean)
        .map(name => {
            const known = GEMINI_VOICES.find(v => v.name === name);
            return known || { name, trait: '', gender: 'unknown' };
        });
}

/** True jika nama voice ada dalam daftar aktif. */
export function isKnownVoice(env, name) {
    return listVoices(env).some(v => v.name === name);
}

/** Ambil objek voice {name,trait,gender} dari daftar aktif, atau null. env opsional (pakai default). */
export function getVoice(name, env) {
    return listVoices(env).find(v => v.name === name) || null;
}

// Kosakata emosi TERKURASI untuk video affiliate. Dipakai juga oleh ai.js (sinkron).
export const ALLOWED_EMOTIONS = [
    'Penasaran', 'Prihatin', 'Terinspirasi', 'Yakin', 'Antusias', 'Terbukti', 'Mendesak', 'Ramah',
];

// Peta label emosi -> frasa gaya natural (nuansa adegan). Ditumpuk di atas baseline energik.
const EMOTION_STYLE = {
    'Penasaran': 'penasaran dan penuh tanya',
    'Prihatin': 'peduli dan prihatin',
    'Terinspirasi': 'terinspirasi dan membangkitkan semangat',
    'Yakin': 'yakin dan meyakinkan',
    'Antusias': 'bersemangat dan berenergi',
    'Terbukti': 'keyakinan karena bukti nyata',
    'Mendesak': 'tegas dan mendesak',
    'Ramah': 'ramah dan hangat',
    'Serius': 'serius dan berwibawa',
    'Heran': 'terkejut dan takjub',
    'Hopeful': 'penuh harap dan optimis',
};

/** Frasa nuansa untuk emosi tertentu ("" bila netral/tak perlu penyesuaian). */
export function styleForEmotion(emotion) {
    const e = String(emotion || '').trim();
    if (!e || e.toLowerCase() === 'netral') return '';
    return EMOTION_STYLE[e] || e.toLowerCase();
}

/**
 * Instruksi gaya TTS. Mode "natural" (default) meniru penyampaian manusia realistis;
 * mode "energetic" mempertahankan gaya lama (berteriak) untuk perbandingan.
 * Dipakai Gemini (systemInstruction / prompt) maupun AIVene (instructions).
 */
export function buildTtsStyle(emotion, env) {
    const nuance = styleForEmotion(emotion) || 'hangat dan antusias';
    if (String((env && env.TTS_STYLE_MODE) || 'natural').toLowerCase() === 'energetic') {
        return 'Kamu pengisi suara video affiliate Indonesia. '
            + 'Bicaralah dengan ENERGI TINGGI, jelas, hidup, dan meyakinkan sepanjang kalimat; '
            + 'jangan datar atau kaku. Nada adegan ini: ' + nuance + '.';
    }
    return 'Kamu pengisi suara video affiliate Indonesia yang natural dan realistis, '
        + 'seperti merekomendasikan produk ke teman. Artikulasi jelas, intonasi hidup, tempo wajar, '
        + 'jeda napas alami; jangan datar dan jangan berteriak. Nada adegan ini: ' + nuance + '.';
}

/** Gaya yang ditanam di dalam prompt teks (dipakai bila model menolak systemInstruction). */
export function stylePrompt(text, emotion, env) {
    return buildTtsStyle(emotion, env) + ' Ucapkan kalimat berikut apa adanya: ' + text;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** True bila byte sudah berupa container WAV (RIFF) sehingga tidak boleh dibungkus ulang. */
function isWavContainer(bytes) {
    return !!bytes && bytes.byteLength > 12
        && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
}

// Di-set false sekali bila model menolak field systemInstruction (hindari 400 berulang).
let _systemInstructionSupported = true;

/** Jeda sebelum percobaan ulang: hormati Retry-After, jika tidak ada pakai backoff terjadwal. */
function retryDelay(res, attempt) {
    const ra = Number(res && res.headers && res.headers.get('Retry-After'));
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 8000);
    return TTS_RETRY_DELAYS_MS[Math.min(attempt, TTS_RETRY_DELAYS_MS.length - 1)];
}

/** Tulis string ASCII ke DataView pada offset. */
function writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/** Bungkus PCM 16-bit LE mono/stereo menjadi buffer WAV (agar bisa didecode browser). */
export function pcmToWav(pcmBytes, sampleRate, channels) {
    const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 24000;
    const ch = Number(channels) > 0 ? Number(channels) : 1;
    const dataLen = pcmBytes.byteLength;
    const buf = new ArrayBuffer(44 + dataLen);
    const view = new DataView(buf);
    writeStr(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLen, true);
    writeStr(view, 8, 'WAVE');
    writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);          // PCM chunk size
    view.setUint16(20, 1, true);           // format = PCM
    view.setUint16(22, ch, true);          // channels
    view.setUint32(24, rate, true);        // sample rate
    view.setUint32(28, rate * ch * 2, true); // byte rate
    view.setUint16(32, ch * 2, true);      // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeStr(view, 36, 'data');
    view.setUint32(40, dataLen, true);
    new Uint8Array(buf, 44).set(pcmBytes);
    return new Uint8Array(buf);
}

/** Parse sample rate & channel dari mimeType Gemini (mis. "audio/L16;codec=pcm;rate=24000"). */
function parsePcmMeta(mimeType) {
    let sampleRate = 24000;
    let channels = 1;
    const m = /rate=(\d+)/i.exec(mimeType || '');
    if (m) sampleRate = Number(m[1]) || sampleRate;
    return { sampleRate, channels };
}

/** Decode base64 (string) menjadi Uint8Array (tersedia di Workers via atob). */
function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Satu panggilan Gemini TTS ke satu model. Melempar Error ber-.status untuk HTTP gagal;
 * 429/503 diulang dengan backoff (menghormati Retry-After).
 */
async function callGeminiTts(env, model, { text, voiceName, emotion }, useSystemInstruction, timeoutMs) {
    const body = {
        contents: [{ parts: [{ text: useSystemInstruction ? text : stylePrompt(text, emotion, env) }] }],
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
    };
    if (useSystemInstruction) {
        body.systemInstruction = { parts: [{ text: buildTtsStyle(emotion, env) }] };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    let lastErr = null;

    for (let attempt = 0; attempt < TTS_RETRY_DELAYS_MS.length; attempt++) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || ttsTimeout(env))),
        });
        if (res.ok) return await res.json();

        let msg = '';
        try { const j = await res.json(); msg = (j && j.error && j.error.message) || ''; } catch (e) { /* non-json */ }
        const err = new Error(`Gemini TTS HTTP ${res.status}${msg ? ': ' + msg : ''}`);
        err.status = res.status;
        if (res.status !== 429 && res.status !== 503) throw err;
        lastErr = err;
        if (attempt < TTS_RETRY_DELAYS_MS.length - 1) await sleep(retryDelay(res, attempt));
    }
    throw lastErr;
}

/**
 * Sintesis via Gemini TTS -> { bytes:Uint8Array, contentType, provider:'gemini', model }.
 * Mencoba model utama tier lalu fallback-nya. Mendukung dua bentuk respons:
 * PCM mentah (audio/L16 -> dibungkus WAV) dan container audio/wav (dipakai apa adanya).
 */
export async function synthesizeGemini(env, { text, voiceName, emotion, tier }) {
    const models = tierModels(env, tier);
    const errors = [];
    const statuses = [];
    // Anggaran waktu TOTAL rantai model: tanpa ini, 429 beruntun bisa menahan satu request
    // beberapa menit (3 model x 3 percobaan x timeout) sebelum gagal.
    const deadline = Date.now() + chainBudget(env);

    for (const model of models) {
        const remaining = deadline - Date.now();
        if (remaining < 2000) {
            errors.push(`${model}: dilewati (anggaran waktu habis)`);
            break;
        }
        try {
            let data;
            if (_systemInstructionSupported) {
                try {
                    data = await callGeminiTts(env, model, { text, voiceName, emotion }, true, remaining);
                } catch (e) {
                    // Model menolak systemInstruction: matikan permanen untuk proses ini, ulangi tanpa field itu.
                    if (e && e.status === 400) _systemInstructionSupported = false;
                    else throw e;
                }
            }
            if (!data) data = await callGeminiTts(env, model, { text, voiceName, emotion }, false, deadline - Date.now());

            const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
            const audioPart = parts.find(p => p && p.inlineData && p.inlineData.data);
            if (!audioPart) throw new Error('Gemini TTS tidak mengembalikan audio');

            const bytes = base64ToBytes(audioPart.inlineData.data);
            if (!bytes.byteLength) throw new Error('Gemini TTS mengembalikan audio kosong');

            const mime = String(audioPart.inlineData.mimeType || '');
            // Log server (bukan header/response): berguna memantau model mana yang melayani tiap tier.
            console.log(`TTS ok tier=${tier} model=${model} mime=${mime || '-'} ms=${Date.now() - (deadline - chainBudget(env))}`);
            // Sebagian model (mis. 3.8) sudah mengembalikan container WAV: membungkusnya lagi merusak audio.
            if (/wav/i.test(mime) || isWavContainer(bytes)) {
                return { bytes, contentType: 'audio/wav', provider: 'gemini', model };
            }
            const { sampleRate, channels } = parsePcmMeta(mime);
            return { bytes: pcmToWav(bytes, sampleRate, channels), contentType: 'audio/wav', provider: 'gemini', model };
        } catch (e) {
            if (e && e.status) statuses.push(e.status);
            errors.push(`${model}: ${(e && e.message) || e}`);
            // Terlihat di log server: memudahkan tahu model mana yang gagal lalu di-fallback.
            console.warn(`TTS gagal tier=${tier} model=${model}: ${(e && e.message) || e}`);
        }
    }

    // Rincian model & pesan provider HANYA di log server: nama model tidak boleh bocor ke browser.
    console.error('Gemini TTS gagal:', errors.join(' | ') || 'tanpa detail');
    const err = new Error('Gemini TTS gagal membuat suara');
    err.status = statuses.includes(429) ? 429 : 502;
    throw err;
}

/** Sintesis via AIVene (fallback) -> { bytes, contentType:'audio/mpeg', provider:'aivene' }. */
export async function synthesizeAivene(env, { text, emotion }) {
    const base = String(env.AIVENE_BASE_URL || 'https://api.aivene.com/v1').replace(/\/$/, '');
    const url = base.endsWith('/audio/speech') ? base : `${base}/audio/speech`;
    const model = env.AIVENE_TTS_MODEL || 'tts-1';
    const voice = env.AIVENE_TTS_VOICE || 'nova'; // voice AIVene tetap (jangan kirim nama Gemini)

    const body = { model, input: text, voice, response_format: 'mp3', speed: 1.0, instructions: buildTtsStyle(emotion, env) };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AIVENE_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AIVENE_TTS_TIMEOUT_MS),
    });
    if (!res.ok) {
        let msg = '';
        try { const j = await res.json(); msg = (j && j.error && j.error.message) || (j && j.message) || ''; } catch (e) { /* non-json */ }
        const err = new Error(`AIVene TTS HTTP ${res.status}${msg ? ': ' + msg : ''}`);
        err.status = res.status;
        throw err;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.byteLength) throw new Error('AIVene TTS tidak mengembalikan audio');
    return { bytes, contentType: 'audio/mpeg', provider: 'aivene' };
}

/**
 * Router utama suara VO: Gemini TTS lebih dulu (rantai model per tier).
 * AIVene HANYA dipakai bila TTS_ALLOW_DEGRADE="true" - kualitas tidak boleh turun diam-diam.
 * Mengembalikan { bytes, contentType, provider, model } atau melempar Error terakhir (dengan .status).
 */
export async function synthesizeVoice(env, { text, voiceName, emotion, tier }) {
    let lastError = null;
    if (env.GEMINI_API_KEY) {
        try {
            return await synthesizeGemini(env, { text, voiceName, emotion, tier });
        } catch (e) { lastError = e; }
    } else {
        lastError = new Error('GEMINI_API_KEY kosong');
    }
    const degrade = String(env.TTS_ALLOW_DEGRADE || 'false').toLowerCase() === 'true';
    if (degrade && env.AIVENE_API_KEY) {
        try {
            return await synthesizeAivene(env, { text, emotion });
        } catch (e) { lastError = e; }
    }
    throw lastError || new Error('Tidak ada provider TTS yang dikonfigurasi');
}
