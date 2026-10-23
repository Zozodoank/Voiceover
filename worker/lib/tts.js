// worker/lib/tts.js - Sintesis suara VO: Gemini TTS (utama) dengan fallback AIVene.
// Gemini TTS: POST generateContent responseModalities=AUDIO -> PCM (audio/L16) -> dibungkus WAV.
// AIVene (fallback): gateway kompatibel OpenAI /audio/speech -> byte mp3.
// Suara memakai voice & gaya energik yang SAMA di semua tier; tier hanya memilih model penalaran
// (flash vs pro) agar kualitas merata (bukan voice robotik di tier rendah).

const GEMINI_TTS_TIMEOUT_MS = 15000;
const AIVENE_TTS_TIMEOUT_MS = 12000;

// Model TTS default (Normal/Sedang). Pro dipakai untuk tier Tinggi. Override lewat env.
const GEMINI_TTS_MODEL_DEFAULT = 'gemini-2.5-flash-preview-tts';
const GEMINI_TTS_MODEL_PRO_DEFAULT = 'gemini-2.5-pro-preview-tts';

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
 * Instruksi gaya TTS yang SELALU memuat baseline energik (merata di semua tier/model)
 * plus nuansa emosi adegan. Dipakai oleh Gemini (systemInstruction) maupun AIVene (instructions).
 */
export function buildTtsStyle(emotion) {
    const nuance = styleForEmotion(emotion) || 'hangat dan antusias';
    return 'Kamu pengisi suara video affiliate Indonesia. '
        + 'Bicaralah dengan ENERGI TINGGI, jelas, hidup, dan meyakinkan sepanjang kalimat; '
        + 'jangan datar atau kaku. Nada adegan ini: ' + nuance + '.';
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
 * Sintesis via Gemini TTS -> { bytes:Uint8Array (WAV), contentType:'audio/wav', provider:'gemini' }.
 * tier hanya memilih model (flash vs pro); voice & gaya tetap sama.
 */
export async function synthesizeGemini(env, { text, voiceName, emotion, tier }) {
    const model = tier === 'gemini-tts-flash-3.8'
        ? (env.GEMINI_TTS_MODEL_PRO || GEMINI_TTS_MODEL_PRO_DEFAULT)
        : (env.GEMINI_TTS_MODEL || GEMINI_TTS_MODEL_DEFAULT);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

    const body = {
        contents: [{ parts: [{ text }] }],
        systemInstruction: { parts: [{ text: buildTtsStyle(emotion) }] },
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GEMINI_TTS_TIMEOUT_MS),
    });
    if (!res.ok) {
        let msg = '';
        try { const j = await res.json(); msg = (j && j.error && j.error.message) || ''; } catch (e) { /* non-json */ }
        const err = new Error(`Gemini TTS HTTP ${res.status}${msg ? ': ' + msg : ''}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const audioPart = parts.find(p => p && p.inlineData && p.inlineData.data);
    if (!audioPart) throw new Error('Gemini TTS tidak mengembalikan audio');

    const pcm = base64ToBytes(audioPart.inlineData.data);
    if (!pcm.byteLength) throw new Error('Gemini TTS mengembalikan audio kosong');
    const { sampleRate, channels } = parsePcmMeta(audioPart.inlineData.mimeType);
    return { bytes: pcmToWav(pcm, sampleRate, channels), contentType: 'audio/wav', provider: 'gemini' };
}

/** Sintesis via AIVene (fallback) -> { bytes, contentType:'audio/mpeg', provider:'aivene' }. */
export async function synthesizeAivene(env, { text, emotion }) {
    const base = String(env.AIVENE_BASE_URL || 'https://api.aivene.com/v1').replace(/\/$/, '');
    const url = base.endsWith('/audio/speech') ? base : `${base}/audio/speech`;
    const model = env.AIVENE_TTS_MODEL || 'tts-1';
    const voice = env.AIVENE_TTS_VOICE || 'nova'; // voice AIVene tetap (jangan kirim nama Gemini)

    const body = { model, input: text, voice, response_format: 'mp3', speed: 1.0, instructions: buildTtsStyle(emotion) };

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
 * Router utama suara VO: coba Gemini TTS lebih dulu; bila gagal dan AIVene tersedia, fallback.
 * Mengembalikan { bytes, contentType, provider } atau melempar Error terakhir (dengan .status).
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
    if (env.AIVENE_API_KEY) {
        try {
            return await synthesizeAivene(env, { text, emotion });
        } catch (e) { lastError = e; }
    }
    throw lastError || new Error('Tidak ada provider TTS yang dikonfigurasi');
}
