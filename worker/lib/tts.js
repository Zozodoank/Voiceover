// worker/lib/tts.js - Sintesis suara Gemini TTS untuk PRATINJAU suara (gratis, tanpa debit saldo).
// Model TTS terpisah dari model analisa: default gemini-2.5-flash-preview-tts (via env GEMINI_TTS_MODEL).
// Respons Gemini berupa PCM 16-bit mono (rate=NNNN) dibungkus ke WAV agar bisa langsung diputar browser.

// 30 voice prebuilt resmi Gemini TTS + sifat (trait) resminya.
// `gender` hanya perkiraan untuk menentukan nada naskah VO (wanita/pria) - bukan label resmi Google.
export const GEMINI_TTS_VOICES = [
    { name: 'Zephyr',        trait: 'Bright',        gender: 'female' },
    { name: 'Puck',          trait: 'Upbeat',        gender: 'male' },
    { name: 'Charon',        trait: 'Informative',   gender: 'male' },
    { name: 'Kore',          trait: 'Firm',          gender: 'female' },
    { name: 'Fenrir',        trait: 'Excitable',     gender: 'male' },
    { name: 'Leda',          trait: 'Youthful',      gender: 'female' },
    { name: 'Orus',          trait: 'Firm',          gender: 'male' },
    { name: 'Aoede',         trait: 'Breezy',        gender: 'female' },
    { name: 'Callirrhoe',    trait: 'Easy-going',    gender: 'female' },
    { name: 'Autonoe',       trait: 'Bright',        gender: 'female' },
    { name: 'Enceladus',     trait: 'Breathy',       gender: 'male' },
    { name: 'Iapetus',       trait: 'Clear',         gender: 'male' },
    { name: 'Umbriel',       trait: 'Easy-going',    gender: 'male' },
    { name: 'Algieba',       trait: 'Smooth',        gender: 'male' },
    { name: 'Despina',       trait: 'Smooth',        gender: 'female' },
    { name: 'Erinome',       trait: 'Clear',         gender: 'female' },
    { name: 'Algenib',       trait: 'Gravelly',      gender: 'male' },
    { name: 'Rasalgethi',    trait: 'Informative',   gender: 'male' },
    { name: 'Laomedeia',     trait: 'Upbeat',        gender: 'female' },
    { name: 'Achernar',      trait: 'Soft',          gender: 'female' },
    { name: 'Alnilam',       trait: 'Firm',          gender: 'male' },
    { name: 'Schedar',       trait: 'Even',          gender: 'male' },
    { name: 'Gacrux',        trait: 'Mature',        gender: 'female' },
    { name: 'Pulcherrima',   trait: 'Forward',       gender: 'female' },
    { name: 'Achird',        trait: 'Friendly',      gender: 'male' },
    { name: 'Zubenelgenubi', trait: 'Casual',        gender: 'male' },
    { name: 'Vindemiatrix',  trait: 'Gentle',        gender: 'female' },
    { name: 'Sadachbia',     trait: 'Lively',        gender: 'male' },
    { name: 'Sadaltager',    trait: 'Knowledgeable', gender: 'male' },
    { name: 'Sulafat',       trait: 'Warm',          gender: 'female' },
];

const VOICE_MAP = new Map(GEMINI_TTS_VOICES.map(v => [v.name, v]));
const TTS_TIMEOUT_MS = 20000;

/** True jika nama voice ada di daftar prebuilt. */
export function isKnownVoice(name) {
    return VOICE_MAP.has(name);
}

/** Ambil objek voice (name/trait/gender) atau null. */
export function getVoice(name) {
    return VOICE_MAP.get(name) || null;
}

function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/** Bungkus PCM 16-bit mono menjadi buffer WAV (header RIFF 44 byte). */
function pcmToWav(pcmBytes, sampleRate) {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + pcmBytes.length, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);              // PCM chunk size
    view.setUint16(20, 1, true);               // format = PCM
    view.setUint16(22, 1, true);               // channels = mono
    view.setUint32(24, sampleRate, true);      // sample rate
    view.setUint32(28, sampleRate * 2, true);  // byte rate (16-bit mono)
    view.setUint16(32, 2, true);               // block align
    view.setUint16(34, 16, true);              // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, pcmBytes.length, true);
    const out = new Uint8Array(header.byteLength + pcmBytes.length);
    out.set(new Uint8Array(header), 0);
    out.set(pcmBytes, header.byteLength);
    return out;
}

/** Panggil Gemini TTS; kembalikan { mimeType, data(base64 PCM) }. */
async function callGeminiTts(env, voiceName, text) {
    const model = env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
            },
        }),
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!res.ok) {
        const err = new Error(`Gemini TTS HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const inline = parts.map(p => p.inlineData).filter(Boolean)[0];
    if (!inline || !inline.data) throw new Error('Gemini TTS tidak mengembalikan audio');
    return inline;
}

/**
 * Sintesis cuplikan preview -> Uint8Array berisi WAV siap diputar.
 * Melempar Error bila Gemini TTS gagal (rute membalas 502).
 */
export async function synthesizePreview(env, voiceName, text) {
    const inline = await callGeminiTts(env, voiceName, text);
    const m = /rate=(\d+)/.exec(inline.mimeType || '');
    const sampleRate = m ? Number(m[1]) : 24000;
    const pcm = base64ToBytes(inline.data);
    return { wav: pcmToWav(pcm, sampleRate), sampleRate };
}
