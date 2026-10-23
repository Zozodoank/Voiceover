// worker/lib/tts.js - Sintesis suara PRATINJAU VOICE OVER via AIVene (bukan Gemini langsung).
// AIVene adalah gateway kompatibel OpenAI: POST {AIVENE_BASE_URL}/audio/speech -> byte audio.
// Ditagih per detik audio (bukan kuota request/hari Google), jadi tidak kena limit 10/hari Gemini.
// AIVENE-ONLY: tidak ada fallback ke Gemini (sesuai keputusan produk).

const TTS_TIMEOUT_MS = 20000;

// Model TTS default AIVene. Ubah lewat env AIVENE_TTS_MODEL bila memakai model lain (mis. gpt-4o-mini-tts).
const AIVENE_TTS_MODEL_DEFAULT = 'tts-1';

// Daftar voice default (OpenAI/AIVene tts-1). trait/gender hanya perkiraan untuk UI (ikon & nada naskah).
// Override lewat env AIVENE_TTS_VOICES = "alloy,echo,fable,onyx,nova,shimmer" bila katalog Anda beda.
const DEFAULT_VOICES = [
    { name: 'alloy',   trait: 'Netral & jernih', gender: 'male' },
    { name: 'echo',    trait: 'Hangat & berat',  gender: 'male' },
    { name: 'fable',   trait: 'Bercerita',       gender: 'female' },
    { name: 'onyx',    trait: 'Dalam & tenang',  gender: 'male' },
    { name: 'nova',    trait: 'Ceria & jelas',   gender: 'female' },
    { name: 'shimmer', trait: 'Lembut & hidup',  gender: 'female' },
];

/** Daftar voice aktif: dari env AIVENE_TTS_VOICES (nama dipisah koma) atau default. */
export function listVoices(env) {
    const raw = String((env && env.AIVENE_TTS_VOICES) || '').trim();
    if (!raw) return DEFAULT_VOICES;
    return raw.split(',').map(s => s.trim()).filter(Boolean)
        .map(name => ({ name, trait: '', gender: 'unknown' }));
}

/** True jika nama voice ada dalam daftar aktif. */
export function isKnownVoice(env, name) {
    return listVoices(env).some(v => v.name === name);
}

/** Ambil objek voice {name,trait,gender} dari daftar aktif, atau null. env opsional (pakai default). */
export function getVoice(name, env) {
    return listVoices(env).find(v => v.name === name) || null;
}

// Peta label emosi adegan -> frasa gaya natural-language (dikirim sebagai `instructions` AIVene).
const EMOTION_STYLE = {
    'Penasaran': 'penasaran dan penuh tanya',
    'Prihatin': 'peduli dan sedikit murung',
    'Heran': 'terkejut dan takjub',
    'Hopeful': 'penuh harap dan optimis',
    'Yakin': 'yakin dan meyakinkan',
    'Antusias': 'bersemangat dan berenergi',
    'Mendesak': 'tegas dan mendesak',
    'Ramah': 'ramah dan hangat',
    'Serius': 'serius dan berwibawa',
};

/** Frasa gaya untuk emosi tertentu ("" bila netral/tak perlu penyesuaian). */
export function styleForEmotion(emotion) {
    const e = String(emotion || '').trim();
    if (!e || e.toLowerCase() === 'netral') return '';
    return EMOTION_STYLE[e] || e.toLowerCase();
}

/**
 * Sintesis cuplikan preview lewat AIVene /audio/speech -> { bytes:Uint8Array, contentType }.
 * Melempar Error (dengan .status) bila gagal; rute membalas 502/429 sesuai status.
 */
export async function synthesizePreview(env, voiceName, text, emotion) {
    const base = String(env.AIVENE_BASE_URL || 'https://api.aivene.com/v1').replace(/\/$/, '');
    const url = base.endsWith('/audio/speech') ? base : `${base}/audio/speech`;
    const model = env.AIVENE_TTS_MODEL || AIVENE_TTS_MODEL_DEFAULT;

    const body = { model, input: text, voice: voiceName, response_format: 'mp3', speed: 1.0 };
    const instructions = styleForEmotion(emotion);
    if (instructions) body.instructions = instructions; // sebagian model mendukung pengendalian gaya

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AIVENE_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
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
    return { bytes, contentType: 'audio/mpeg' };
}
