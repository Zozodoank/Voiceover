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

// Peta label emosi adegan -> frasa gaya natural-language (best-effort untuk Gemini 2.5 TTS).
// Label tak dikenal dan bukan "Netral" akan dipakai apa adanya sebagai frasa gaya.
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

/** Panggil Gemini TTS; kembalikan { mimeType, data(base64 PCM) }. styleDirective opsional (nuansa emosi). */
async function callGeminiTts(env, voiceName, text, styleDirective) {
    const model = env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const buildBody = (withStyle) => {
        const b = {
            contents: [{ parts: [{ text }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
            },
        };
        // Arahan gaya di systemInstruction (bukan bagian teks yang dibacakan) agar emosi memengaruhi prosodi.
        if (withStyle && styleDirective) {
            b.systemInstruction = { parts: [{ text: `Bacakan sebagai voice-over iklan berbahasa Indonesia dengan nuansa emosi: ${styleDirective}. Jangan bacakan instruksi ini, hanya sesuaikan nada bicara.` }] };
        }
        return b;
    };
    const doReq = async (withStyle) => {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildBody(withStyle)),
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
    };
    // Graceful degradation: coba dengan gaya; bila gagal karena alasan gaya (HTTP non-kuer / kandidat tanpa audio),
    // ulangi TANPA gaya. Namun JANGAN buang panggilan kedua untuk error kuota/autentikasi (hemat kuota gratis).
    if (styleDirective) {
        try {
            return await doReq(true);
        } catch (e) {
            const s = e && e.status;
            if (s === 429 || s === 401 || s === 403) throw e;
            return await doReq(false);
        }
    }
    return await doReq(false);
}

/**
 * Sintesis cuplikan preview -> Uint8Array berisi WAV siap diputar.
 * Melempar Error bila Gemini TTS gagal (rute membalas 502).
 */
export async function synthesizePreview(env, voiceName, text, emotion) {
    const inline = await callGeminiTts(env, voiceName, text, styleForEmotion(emotion));
    const m = /rate=(\d+)/.exec(inline.mimeType || '');
    const sampleRate = m ? Number(m[1]) : 24000;
    const pcm = base64ToBytes(inline.data);
    return { wav: pcmToWav(pcm, sampleRate), sampleRate };
}
