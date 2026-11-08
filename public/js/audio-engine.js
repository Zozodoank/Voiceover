// public/js/audio-engine.js - Mesin audio TTS Gemini:
// 1 video = 1 kali panggil TTS Gemini untuk seluruh naskah video (hemat kuota), lalu
// dipotong cerdas pada lembah hening per adegan ke sceneAudios[] agar timeline berjangkar visual,
// tombol "Dengar" per adegan, burn-in subtitle, .SRT, dan ekspor WebM/MP4 100% sinkron.
// Classic script: memakai global (generatedScenesData, sceneAudios, getSelectedVoice,
// getVisualSource, showToast, apiFetch).

let _audioCtx = null;
let _playToken = 0;            // pembatalan playback aktif (klik Putar/Jeda/Rekam saat diputar)
let _activeSources = [];       // AudioBufferSourceNode aktif agar bisa dihentikan
let _rafId = 0;
let _prerenderInflight = null; // promise prerender aktif (hindari panggilan ganda)
let _prerenderToken = 0;       // pembatalan prerender basi (video/naskah berganti saat masih berjalan)
let _videoAudio = null;        // { buffer, duration, blobUrl, sig } hasil 1x panggilan TTS
let _scenePreviewAudio = null; // Audio/source aktif tombol "Dengar" agar tidak tumpang tindih
let _lastClockLabel = '';      // cache label durasi: DOM hanya ditulis saat detik berubah

const EXPORT_W = 1080, EXPORT_H = 1920, EXPORT_FPS = 30;

// Subtitle burn-in: satu tempat untuk ukuran, warna, dan ritme kemunculan.
const SUB_FONT_PX = 46;
const SUB_LINE_H = 58;
const SUB_MAX_LINES = 2;
const SUB_WORDS_PER_CUE = 3;
const SUB_MAX_WIDTH = EXPORT_W - 160;
const SUB_BOTTOM_PAD = 150;
const SUB_COLOR_IDLE = '#ffffff';
const SUB_COLOR_ACTIVE = '#fde047';
const SUB_STROKE_PX = 5;
const SUB_PAUSE_WEIGHT = 3;

const RECORDER_START_TIMEOUT_MS = 15000;
const SCRIPT_VERSION = 'v4';
const SCENE_GAP_S = 0.12;            // jeda aman antar adegan (hanya dipakai bila masih ada ruang)
const SCENE_END_GUARD_S = 0.12;      // sisa ruang di ujung jendela agar tidak menyentuh adegan berikutnya
const SCENE_MAX_TEMPO = 1.18;        // batas percepatan audio (di atas ini pitch mulai terdengar naik)
const MIN_SCENE_WINDOW_S = 1.2;      // jendela minimal agar tempo tetap wajar
const VISUAL_DRIFT_TOL_S = 0.15;     // toleransi drift video vs jam audio saat pratinjau
const VISUAL_DRIFT_TOL_EXPORT_S = 0.2;
const LEAD_IN_S = 0.35;              // audio mulai setelah perekaman benar-benar berjalan
const SCENE_RETRIES = 1;             // maksimum 1 kali percobaan ulang agar tidak memicu duplikasi panggilan token
const SILENCE_RATIO = 0.006;         // ambang keheningan relatif terhadap peak
const TRIM_PAD_S = 0.06;             // sisa padding setelah pemangkasan keheningan

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Tier kualitas terpilih (id netral; model dipilih server). */
function getSelectedTier() {
    const r = document.querySelector('input[name="ttsModel"]:checked');
    return r ? r.value : '';
}

/** Durasi video aktif (sumber jam visual). 0 bila belum ada video. */
function getVideoDurationS() {
    const v = document.getElementById('mainVideo');
    const d = v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    if (d > 0) return d;
    const badge = document.getElementById('videoDurationBadge');
    const n = badge ? parseFloat(badge.innerText) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Jendela adegan pada timeline video (di-clamp ke durasi video, dijamin end > start). */
function sceneWindow(scene, videoDuration) {
    const limit = videoDuration > 0 ? videoDuration : 0;
    const s = Number(scene && scene.start);
    const e = Number(scene && scene.end);
    let start = Number.isFinite(s) && s >= 0 ? s : 0;
    let end = Number.isFinite(e) && e > start ? e : (limit > 0 ? limit : start + MIN_SCENE_WINDOW_S);
    if (limit > 0) {
        start = Math.min(start, Math.max(0, limit - 0.05));
        end = Math.min(end, limit);
    }
    if (end <= start) end = start + MIN_SCENE_WINDOW_S;
    return { start, end };
}

/** True bila naskah membawa timestamp adegan yang bisa dipakai sebagai jangkar visual. */
function hasSceneWindows(scenes) {
    return (scenes || []).some((s) => {
        const st = Number(s && s.start);
        const en = Number(s && s.end);
        return Number.isFinite(st) && Number.isFinite(en) && en > st;
    });
}

/**
 * Satu-satunya sumber waktu untuk pratinjau, burn-in, ekspor, dan .SRT.
 * Tiap adegan ditempatkan pada jendela visualnya (bukan dirangkai dari durasi audio); sisa
 * selisih diselesaikan tempo <= SCENE_MAX_TEMPO, dan ekor adegan tidak pernah menimpa adegan
 * berikutnya. Naskah lama tanpa timestamp tetap memakai urutan berurutan (perilaku sebelumnya).
 */
function planTimeline(scenes, audios, videoDuration) {
    const list = scenes || [];
    const videoTotal = Number(videoDuration) > 0 ? Number(videoDuration) : 0;
    const anchored = hasSceneWindows(list);
    // Audio hasil sintesis nyata (_videoAudio) dikunci pada tempo 1.0x agar pitch suara TIDAK naik
    // (AudioBufferSourceNode.playbackRate > 1 menaikkan frekuensi/tone suara seperti chipmunk).
    const isRealTtsAudio = !!(_videoAudio && _videoAudio.sig && _videoAudio.sig === sceneAudioSignature());
    const maxTempo = isRealTtsAudio ? 1.0 : SCENE_MAX_TEMPO;
    const segments = [];
    let prevEnd = 0;
    for (let i = 0; i < list.length; i++) {
        const a = audios && audios[i];
        if (!a || !a.buffer) continue;
        const audioDur = Math.max(0.2, a.duration || a.buffer.duration || 0.2);
        let start;
        let avail;
        if (anchored) {
            const win = sceneWindow(list[i], videoTotal);
            avail = Math.max(0.4, (win.end - win.start) - SCENE_END_GUARD_S);
            start = segments.length === 0 ? win.start : Math.max(win.start, prevEnd + SCENE_GAP_S);
        } else {
            avail = audioDur;
            start = segments.length === 0 ? 0 : prevEnd + SCENE_GAP_S;
        }
        const rate = Math.min(maxTempo, Math.max(1, audioDur / avail));
        const dur = audioDur / rate;
        const end = start + dur;
        segments.push({
            index: i,
            start,
            end,
            dur,
            rate,
            audioDur,
            text: list[i].text || '',
            emotion: list[i].emotion || '',
            cues: buildSubtitleCues(list[i].text, start, end),
        });
        prevEnd = end;
    }
    const lastEnd = segments.length ? segments[segments.length - 1].end : 0;
    return { segments, total: Math.max(videoTotal, lastEnd), videoDuration: videoTotal, anchored };
}

function audioCtx() {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') {
        try { _audioCtx.resume(); } catch (e) { /* ignore */ }
    }
    return _audioCtx;
}

/** Resume AudioContext dengan batas tunggu pendek agar tidak pernah menggantung saat gesture kedaluwarsa. */
async function resumeAudioCtx(ctx) {
    if (!ctx || ctx.state !== 'suspended') return;
    try {
        await Promise.race([ctx.resume(), sleep(250)]);
    } catch (e) { /* ignore */ }
}

/** Signature voice + tier + isi naskah + jendela visual (deteksi perlu prerender ulang tidak). */
function sceneAudioSignature() {
    const v = (typeof getSelectedVoice === 'function') ? getSelectedVoice().name : '';
    const windows = (generatedScenesData || [])
        .map(s => (s.start == null ? '' : s.start) + '-' + (s.end == null ? '' : s.end)).join(',');
    return SCRIPT_VERSION + '|' + v + '|' + getSelectedTier() + '|' + getVideoDurationS().toFixed(2) + '|' + windows + '|'
        + (generatedScenesData || []).map(s => (s.emotion || '') + '#' + (s.text || '')).join('|');
}

/** Alias kompatibilitas. */
function videoAudioSignature() {
    return sceneAudioSignature();
}

/** Decode audio blob menjadi AudioBuffer dengan kompatibilitas lintas-browser (tanpa butuh ctx running). */
async function decodeAudioBlob(blob) {
    const ctx = audioCtx();
    const arrayBuffer = await blob.arrayBuffer();
    return new Promise((resolve, reject) => {
        let settled = false;
        const onSuccess = (buf) => {
            if (!settled) { settled = true; resolve(buf); }
        };
        const onError = (err) => {
            if (!settled) { settled = true; reject(err || new Error('Gagal memproses data audio')); }
        };
        try {
            const p = ctx.decodeAudioData(arrayBuffer, onSuccess, onError);
            if (p && typeof p.then === 'function') {
                p.then(onSuccess).catch(onError);
            }
        } catch (e) {
            onError(e);
        }
    });
}

/**
 * Panggil POST /api/tts/preview: 1 kali per video untuk naskah gabungan.
 */
async function fetchPreviewBuffer(voiceName, text, emotion, tier) {
    const res = await fetch('/api/tts/preview', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceName, text, emotion: emotion || undefined, tier: tier || undefined }),
    });
    const ct = res.headers.get('Content-Type') || '';
    if (!res.ok || ct.indexOf('audio') === -1) {
        let errJson = null;
        try { errJson = await res.json(); } catch (e) { /* non-json */ }
        const msg = (errJson && errJson.message) || ('tts_' + res.status);
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }
    const blob = await res.blob();
    const buf = await decodeAudioBlob(blob);
    return { buffer: buf, duration: buf.duration, blobUrl: URL.createObjectURL(blob) };
}

/** Panggilan TTS dengan percobaan ulang otomatis saat 429/502/503. */
async function fetchSceneAudioWithRetry(voiceName, text, emotion, tier) {
    let lastErr = null;
    for (let attempt = 0; attempt <= SCENE_RETRIES; attempt++) {
        try {
            return await fetchPreviewBuffer(voiceName, text, emotion, tier);
        } catch (e) {
            lastErr = e;
            const code = (e && e.status) || Number((String((e && e.message) || '').match(/tts_(\d{3})/) || [])[1] || 0);
            const permanent = code >= 400 && code < 500 && code !== 429;
            if (permanent || attempt === SCENE_RETRIES) break;
            await sleep(code === 429 ? 2000 * (attempt + 1) : 700 * (attempt + 1));
        }
    }
    throw lastErr;
}

/**
 * Buang keheningan awal/akhir hasil TTS agar suara mulai tepat di awal jendela adegan.
 */
function trimSilence(buffer) {
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
    }
    if (peak <= 0) return buffer;

    const threshold = peak * SILENCE_RATIO;
    let start = 0;
    while (start < data.length && Math.abs(data[start]) < threshold) start++;
    let end = data.length - 1;
    while (end > start && Math.abs(data[end]) < threshold) end--;

    const pad = Math.floor(buffer.sampleRate * TRIM_PAD_S);
    start = Math.max(0, start - pad);
    end = Math.min(data.length - 1, end + pad);
    const length = end - start + 1;
    if (length <= 0 || length >= data.length) return buffer;

    const out = audioCtx().createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        out.copyToChannel(buffer.getChannelData(ch).subarray(start, end + 1), ch);
    }
    return out;
}

/** Bobot ucap satu kalimat adegan (jumlah huruf + bobot jeda tanda baca). */
function sceneSpeechWeight(text) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 1;
    return words.reduce((sum, w) => sum + Math.max(1, w.length) + (/[,.;:!?]$/.test(w) ? SUB_PAUSE_WEIGHT : 0), 0) + SUB_PAUSE_WEIGHT;
}

/** Bungkus AudioBuffer menjadi WAV Blob URL agar elemen Audio() di playCachedSceneAudio bisa memutarnya. */
function audioBufferToWavUrl(buffer) {
    const rate = buffer.sampleRate || 24000;
    const ch = 1;
    const samples = buffer.getChannelData(0);
    const dataLen = samples.length * 2;
    const ab = new ArrayBuffer(44 + dataLen);
    const view = new DataView(ab);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataLen, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, ch, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * ch * 2, true);
    view.setUint16(32, ch * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataLen, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return URL.createObjectURL(new Blob([ab], { type: 'audio/wav' }));
}

/**
 * Bagi 1 AudioBuffer utuh menjadi N segmen per adegan dengan mencari lembah hening
 * (silence valley) di sekitar titik proporsional bobot kata tiap adegan.
 */
function splitAudioBufferByScenes(fullBuffer, scenes) {
    const count = (scenes && scenes.length) || 0;
    if (count <= 0) return [];
    const trimmed = trimSilence(fullBuffer);
    if (count === 1) {
        return [{
            buffer: trimmed,
            duration: trimmed.duration,
            blobUrl: audioBufferToWavUrl(trimmed),
        }];
    }

    const totalSamples = trimmed.length;
    const rate = trimmed.sampleRate || 24000;
    const data = trimmed.getChannelData(0);
    const weights = scenes.map(s => sceneSpeechWeight(s && s.text));
    const totalWeight = weights.reduce((a, b) => a + b, 0) || count;

    // Cari apakah buffer memiliki sinyal suara nyata
    let peak = 0;
    for (let i = 0; i < totalSamples; i++) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
    }

    // Jendela energi 120ms (> durasi penutupan konsonan [t]/[k]/[p] 30-50ms) agar pemotongan
    // selalu jatuh di jeda antar-kalimat sejati (400-600ms), bukan di tengah kata.
    const winSamples = Math.max(32, Math.floor(rate * 0.12));
    const searchRadius = Math.min(
        Math.floor(rate * 0.90),
        Math.floor(totalSamples / (count * 1.8))
    );

    const cuts = [0];
    let accWeight = 0;
    for (let i = 0; i < count - 1; i++) {
        accWeight += weights[i];
        const expected = Math.round((accWeight / totalWeight) * totalSamples);
        let bestCut = expected;
        if (peak > 0 && searchRadius > winSamples) {
            const lo = Math.max(cuts[i] + winSamples, expected - searchRadius);
            const hi = Math.min(totalSamples - winSamples * (count - i), expected + searchRadius);
            let minEnergy = Infinity;
            const step = Math.max(1, Math.floor(winSamples / 8));
            for (let pos = lo; pos <= hi; pos += step) {
                let sum = 0;
                for (let k = 0; k < winSamples && (pos + k) < totalSamples; k++) {
                    const v = data[pos + k];
                    sum += v * v;
                }
                // Penalti jarak kuadratik agar memilih jeda kalimat terdekat dari proporsi kata
                const normDist = Math.abs(pos - expected) / Math.max(1, searchRadius);
                const distPenalty = 1 + 2.5 * normDist * normDist;
                const score = sum * distPenalty;
                if (score < minEnergy) {
                    minEnergy = score;
                    bestCut = pos + Math.floor(winSamples / 2);
                }
            }
        }
        cuts.push(bestCut);
    }
    cuts.push(totalSamples);

    // Pastikan setiap potongan memiliki minimal 1 sampel dan berurutan naik
    const minSlice = Math.max(1, Math.floor(totalSamples * 0.04 / count));
    for (let i = 1; i < cuts.length - 1; i++) {
        const minAllowed = cuts[i - 1] + minSlice;
        const maxAllowed = totalSamples - minSlice * (cuts.length - 1 - i);
        cuts[i] = Math.max(minAllowed, Math.min(maxAllowed, cuts[i]));
    }

    const ctx = audioCtx();
    const fadeSamples = Math.min(Math.floor(rate * 0.012), 288); // 12ms micro-fade cegah klik
    const out = [];
    for (let i = 0; i < count; i++) {
        const s0 = cuts[i];
        const s1 = Math.max(s0 + 1, cuts[i + 1]);
        const len = s1 - s0;
        const rawSlice = ctx.createBuffer(trimmed.numberOfChannels, len, rate);
        for (let ch = 0; ch < trimmed.numberOfChannels; ch++) {
            const sub = trimmed.getChannelData(ch).subarray(s0, s1);
            const dst = rawSlice.getChannelData(ch);
            dst.set(sub);
            const fLen = Math.min(fadeSamples, Math.floor(len / 4));
            for (let k = 0; k < fLen; k++) {
                const g = k / fLen;
                dst[k] *= g;
                dst[len - 1 - k] *= g;
            }
        }
        const slice = peak > 0 ? trimSilence(rawSlice) : rawSlice;
        out.push({
            buffer: slice,
            duration: slice.duration,
            blobUrl: audioBufferToWavUrl(slice),
        });
    }
    return out;
}

/**
 * 1 VIDEO = 1 PANGGILAN TTS GEMINI.
 * Menggabungkan naskah seluruh adegan menjadi satu kalimat berjeda alami, memanggil Gemini TTS
 * sekali, lalu memotong hasilnya ke sceneAudios[] per adegan.
 */
async function prerenderSceneAudios(onProgress) {
    const myTok = ++_prerenderToken;
    const scenes = generatedScenesData || [];
    if (!scenes.length) throw new Error('Naskah video belum tersedia.');

    const fullScript = scenes
        .map(s => {
            const t = String((s && s.text) || '').trim();
            if (!t) return '';
            return /[.!?]$/.test(t) ? t : (t + '.');
        })
        .filter(Boolean)
        .join(' ');
    if (!fullScript) throw new Error('Teks naskah video kosong.');

    const vName = (typeof getSelectedVoice === 'function') ? getSelectedVoice().name : 'Kore';
    const tier = getSelectedTier() || 'tier-normal';
    const primaryEmotion = (scenes[0] && scenes[0].emotion) || 'Antusias';
    const sig = sceneAudioSignature();

    (sceneAudios || []).forEach(a => {
        if (a && a.blobUrl) { try { URL.revokeObjectURL(a.blobUrl); } catch (e) { /* ignore */ } }
    });
    sceneAudios = new Array(scenes.length).fill(null);
    sceneAudiosKey = '';

    const raw = await fetchSceneAudioWithRetry(vName, fullScript, primaryEmotion, tier);
    if (myTok !== _prerenderToken) {
        if (raw && raw.blobUrl) { try { URL.revokeObjectURL(raw.blobUrl); } catch (e) { /* ignore */ } }
        return { ok: 0, fail: 0, stale: true };
    }

    if (_videoAudio && _videoAudio.blobUrl) {
        try { URL.revokeObjectURL(_videoAudio.blobUrl); } catch (e) { /* ignore */ }
    }
    const buf = trimSilence(raw.buffer);
    _videoAudio = {
        buffer: buf,
        duration: buf.duration,
        blobUrl: raw.blobUrl,
        sig,
    };

    sceneAudios = splitAudioBufferByScenes(buf, scenes);
    sceneAudiosKey = sig;

    if (typeof onProgress === 'function') {
        try { onProgress(scenes.length, scenes.length); } catch (e) { /* ignore */ }
    }
    return { ok: scenes.length, fail: 0 };
}

/**
 * Batalkan audio hasil prerender (video/naskah/suara/tier berganti).
 * Prerender yang masih berjalan dihentikan lewat _prerenderToken.
 */
function invalidateSceneAudios() {
    _prerenderToken++;
    _prerenderInflight = null;
    if (_videoAudio && _videoAudio.blobUrl) {
        try { URL.revokeObjectURL(_videoAudio.blobUrl); } catch (e) { /* ignore */ }
    }
    _videoAudio = null;
    (sceneAudios || []).forEach(a => {
        if (a && a.blobUrl) {
            try { URL.revokeObjectURL(a.blobUrl); } catch (e) { /* ignore */ }
        }
    });
    sceneAudios = [];
    sceneAudiosKey = '';
}

/** Nomor adegan (1-based) yang audionya belum ada. */
function missingSceneNumbers() {
    const out = [];
    (generatedScenesData || []).forEach((s, i) => {
        const a = sceneAudios && sceneAudios[i];
        if (!a || !a.buffer) out.push(i + 1);
    });
    return out;
}

/** Pastikan sceneAudios cocok dengan naskah/voice/tier terpilih; prerender bila perlu. */
async function ensureSceneAudios(onProgress) {
    if (_prerenderInflight) {
        try { await _prerenderInflight; } catch (e) { /* periksa ulang di bawah */ }
    }
    const sig = sceneAudioSignature();
    const complete = sceneAudios.length === (generatedScenesData || []).length && sceneAudios.length > 0;
    if (sceneAudiosKey === sig && complete && !missingSceneNumbers().length) return;
    _prerenderInflight = prerenderSceneAudios(onProgress)
        .then((r) => { _prerenderInflight = null; return r; })
        .catch((e) => { _prerenderInflight = null; throw e; });
    await _prerenderInflight;
}

/** Alias kompatibilitas. */
async function ensureVideoAudio(onProgress) {
    return await ensureSceneAudios(onProgress);
}

/** Validasi seluruh adegan sudah memiliki buffer audio sebelum diputar/diekspor. */
function assertAllAudio() {
    const missing = missingSceneNumbers();
    if (missing.length) throw new Error('audio_missing:' + missing.join(','));
}

/**
 * Timeline tunggal berjangkar visual: dipakai playback, burn-in, dan ekspor .SRT.
 * -> { segments:[{ index, start, end, dur, rate, text, emotion, cues }], total, videoDuration, anchored }
 */
function buildTimeline() {
    return planTimeline(generatedScenesData || [], sceneAudios || [], getVideoDurationS());
}

// Dipakai playback.js / studio.js untuk ekspor .SRT & label durasi adegan yang sinkron
window.getSceneTimeline = () => buildTimeline();

/** True bila waktu berada di dalam jendela bicara adegan tsb. */
function subtitleIndexAt(segments, elapsed) {
    for (let i = 0; i < segments.length; i++) {
        if (elapsed >= segments[i].start && elapsed < segments[i].end) return i;
    }
    return -1;
}

/** Jadwalkan seluruh adegan sesuai jendela timeline pada ctx. */
function scheduleScenes(ctx, destNodes, leadIn) {
    assertAllAudio();
    const timeline = buildTimeline();
    const scheduledAt = ctx.currentTime;
    const scheduledWall = performance.now();
    const startTime = scheduledAt + (Number.isFinite(leadIn) && leadIn >= 0 ? leadIn : 0.08);
    _activeSources = [];
    timeline.segments.forEach((seg) => {
        const a = sceneAudios[seg.index];
        if (!a || !a.buffer) return;
        const src = ctx.createBufferSource();
        src.buffer = a.buffer;
        if (seg.rate && Math.abs(seg.rate - 1) > 0.001) src.playbackRate.value = seg.rate;
        destNodes.forEach(d => src.connect(d));
        src.start(startTime + seg.start);
        _activeSources.push(src);
    });
    return {
        startTime,
        scheduledAt,
        scheduledWall,
        timeline,
        stop: () => {
            _activeSources.forEach(s => { try { s.stop && s.stop(); } catch (e) { /* ignore */ } });
            _activeSources = [];
        },
    };
}

/** Jam detik berjalan untuk menggambar frame playback maupun ekspor. */
function createRunClock(ctx, run) {
    const leadS = run.startTime - run.scheduledAt;
    let last = 0;
    return function elapsedSeconds() {
        const audio = ctx.currentTime - run.startTime;
        const wall = (performance.now() - run.scheduledWall) / 1000 - leadS;
        const next = Math.max(audio, wall, 0);
        if (next > last) last = next;
        return last;
    };
}

/** Sinkronkan elemen video ke detik clock. */
function syncVisualToClock(el, elapsed, tol) {
    if (!el || !(el.duration > 0)) return;
    const target = Math.max(0, Math.min(elapsed, el.duration - 0.05));
    if (el.paused) { try { el.play(); } catch (e) { /* ignore */ } }
    if (Math.abs(el.currentTime - target) > (tol || VISUAL_DRIFT_TOL_S)) {
        try { el.currentTime = target; } catch (e) { /* ignore */ }
    }
}

/** Kembalikan video ke keadaan normal setelah pratinjau/ekspor. */
function restoreVisualAfterPlayback() {
    const v = document.getElementById('mainVideo');
    if (!v) return;
    v.loop = false;
    v.muted = false;
    if (!v.paused) { try { v.pause(); } catch (e) { /* ignore */ } }
}

function subtitlesEnabled() {
    const cb = document.getElementById('subtitleCheckbox');
    return cb ? !!cb.checked : true;
}

function fmtClock(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function paintPlaybackClock(elapsed, total) {
    const el = document.getElementById('totalDurationLabel');
    if (!el) return;
    const label = fmtClock(elapsed) + ' / ' + fmtClock(total);
    if (label === _lastClockLabel) return;
    _lastClockLabel = label;
    el.innerText = label;
}

/**
 * Putar cuplikan satu adegan dari buffer audio adegan yang sudah ada di memori (tanpa request API baru).
 */
function playCachedSceneAudio(idx) {
    const a = sceneAudios && sceneAudios[idx];
    if (!a || (!a.blobUrl && !a.buffer)) return false;
    const seg = buildTimeline().segments.find(s => s.index === idx);
    const rate = seg && seg.rate > 1 ? Math.min(SCENE_MAX_TEMPO, seg.rate) : 1;

    if (_scenePreviewAudio) {
        try {
            if (typeof _scenePreviewAudio.stop === 'function') _scenePreviewAudio.stop();
            else if (typeof _scenePreviewAudio.pause === 'function') _scenePreviewAudio.pause();
        } catch (e) { /* ignore */ }
        _scenePreviewAudio = null;
    }

    if (a.blobUrl) {
        const el = new Audio(a.blobUrl);
        el.playbackRate = rate;
        _scenePreviewAudio = el;
        el.play().catch(() => { /* autoplay ditolak */ });
        return true;
    }

    const ctx = audioCtx();
    const src = ctx.createBufferSource();
    src.buffer = a.buffer;
    src.playbackRate.value = rate;
    src.connect(ctx.destination);
    src.start(0);
    _scenePreviewAudio = src;
    return true;
}

/** Perbarui overlay pratinjau subtitle. */
function updateOverlayDOM(sceneIdx, sub) {
    renderOverlaySubtitle(sub);
}

function renderOverlaySubtitle(sub) {
    const el = document.getElementById('subtitleOverlayText');
    if (!el) return;
    el.textContent = '';
    if (!subtitlesEnabled() || !sub || !sub.cue) return;
    sub.cue.words.forEach((w, i) => {
        if (i) el.appendChild(document.createTextNode(' '));
        const span = document.createElement('span');
        span.className = (w === sub.word) ? 'sub-word sub-word-active' : 'sub-word';
        span.textContent = w.text;
        el.appendChild(span);
    });
}

function clearSubtitleText() { renderOverlaySubtitle(null); }

function stopEverything() {
    _playToken++;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
    _activeSources.forEach(s => { try { s.stop && s.stop(); } catch (e) { /* ignore */ } });
    _activeSources = [];
    if (_scenePreviewAudio) {
        try {
            if (typeof _scenePreviewAudio.stop === 'function') _scenePreviewAudio.stop();
            else if (typeof _scenePreviewAudio.pause === 'function') _scenePreviewAudio.pause();
        } catch (e) { /* ignore */ }
        _scenePreviewAudio = null;
    }
    restoreVisualAfterPlayback();
    ['subtitleOverlayContainer', 'sceneOverlayBadge'].forEach(id => {
        const el = document.getElementById(id); if (el) el.classList.add('hidden');
    });
}

/**
 * Mulai pemutaran gabungan tersinkron (video + jadwal adegan VO berjangkar visual + subtitle).
 */
async function startMergedPlayback() {
    await ensureSceneAudios();
    assertAllAudio();
    if (!generatedScenesData || !generatedScenesData.length) return;

    stopEverything();
    const myTok = ++_playToken;
    const ctx = audioCtx();
    await resumeAudioCtx(ctx);
    if (_playToken !== myTok) return;
    ctx._tok = myTok;

    const run = scheduleScenes(ctx, [ctx.destination], 0.12);
    const clock = createRunClock(ctx, run);
    const src = getVisualSource();
    if (src.type === 'video' && src.el) {
        try {
            src.el.loop = false;
            src.el.muted = true;
            src.el.currentTime = 0;
            const p = src.el.play();
            if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay */ });
        } catch (e) { /* autoplay */ }
    }

    const subOn = subtitlesEnabled();
    document.getElementById('subtitleOverlayContainer').classList.toggle('hidden', !subOn);
    paintPlaybackClock(0, run.timeline.total);

    let lastKey = '';
    (function loop() {
        if (_playToken !== myTok) return;
        const elapsed = clock();
        if (elapsed >= run.timeline.total) {
            stopEverything();
            if (typeof resetPlayBtn === 'function') resetPlayBtn();
            return;
        }
        if (src.type === 'video') syncVisualToClock(src.el, elapsed, VISUAL_DRIFT_TOL_S);
        paintPlaybackClock(elapsed, run.timeline.total);

        const idx = subtitleIndexAt(run.timeline.segments, elapsed);
        const seg = idx >= 0 ? run.timeline.segments[idx] : null;
        const cue = seg ? subtitleCueAt(seg.cues, elapsed) : null;
        const word = activeSubtitleWord(cue, elapsed);
        const key = (seg ? seg.index : -1) + '|' + (cue ? cue.start : '') + '|' + (word ? word.start : '');
        if (key !== lastKey) {
            updateOverlayDOM(seg ? seg.index : -1, { cue, word });
            lastKey = key;
        }
        _rafId = requestAnimationFrame(loop);
    })();
}

function resetPlayBtn() {
    const t = document.getElementById('playMergedText');
    const ic = document.getElementById('playMergedIcon');
    if (t) t.innerText = 'Putar';
    if (ic) ic.className = 'fa-solid fa-play';
    isPlayingMerged = false;
}

/**
 * Ekspor video WebM/MP4 nyata: rekaman kanvas 30fps + audio VO berjangkar visual + burn-in subtitle.
 */
async function exportMergedVideoWebM() {
    const btn = document.getElementById('exportMergedBtn');
    const label = document.getElementById('exportBtnLabel');
    if (btn && btn.disabled) return;
    if (!generatedScenesData || !generatedScenesData.length) {
        showToast('Buat Voice Over dulu sebelum mengunduh.', 'error');
        return;
    }
    if (!window.MediaRecorder) {
        showToast('Browser ini tidak mendukung pembuatan video langsung. Silakan gunakan unduh file .SRT.', 'error');
        return;
    }
    if (!HTMLCanvasElement.prototype.captureStream) {
        showToast('Pembuatan video tidak didukung pada browser ini. Silakan gunakan opsi unduh .SRT.', 'error');
        return;
    }

    const setBusy = (busy, text) => {
        if (btn) btn.disabled = busy;
        if (label) label.innerText = busy ? (text || 'Merekam…') : 'Unduh';
    };

    const ctx = audioCtx();
    await resumeAudioCtx(ctx);

    setBusy(true, 'Menyiapkan suara…');
    stopEverything();
    try {
        await ensureSceneAudios((done, total) => setBusy(true, `Suara ${done}/${total}…`));
        assertAllAudio();
        setBusy(true, 'Merekam…');

        const mimeType = pickWebmMime();
        if (!mimeType) throw new Error('Format video tidak didukung browser.');

        const comp = document.createElement('canvas');
        comp.width = EXPORT_W; comp.height = EXPORT_H;
        const cctx = comp.getContext('2d');

        const dest = ctx.createMediaStreamDestination();
        const myTok = ++_playToken; ctx._tok = myTok;

        let stream;
        try {
            stream = comp.captureStream(EXPORT_FPS);
        } catch (e) {
            stream = comp.captureStream();
        }
        const vTrack = stream.getVideoTracks()[0];
        dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));

        const chunks = [];
        let recorder;
        try {
            recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
        } catch (e) {
            try {
                recorder = new MediaRecorder(stream, { mimeType });
            } catch (e2) {
                recorder = new MediaRecorder(stream);
            }
        }
        const actualMime = recorder.mimeType || mimeType || 'video/webm';
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

        let resolveDone;
        const done = new Promise((resolve) => {
            resolveDone = resolve;
            recorder.onstop = () => resolve();
            recorder.onerror = () => resolve();
        });

        // Siapkan video di detik 0 sebelum perekam menyala agar frame pertama langsung berisi visual produk
        const vis = getVisualSource();
        if (vis.type === 'video' && vis.el) {
            try {
                vis.el.loop = false;
                vis.el.muted = true;
                vis.el.pause();
                if (vis.el.currentTime > 0.05) {
                    await new Promise((res) => {
                        const t = setTimeout(res, 600);
                        vis.el.addEventListener('seeked', () => { clearTimeout(t); res(); }, { once: true });
                        try { vis.el.currentTime = 0; } catch (e) { clearTimeout(t); res(); }
                    });
                }
            } catch (e) { /* ignore */ }
        }

        // Nyalakan osilator keep-alive SEBELUM recorder.start() agar track audio MediaStreamDestination
        // langsung memancarkan paket audio sejak milidetik ke-0 (mencegah muxer menunggu tanpa batas).
        let kaOsc = null;
        try {
            const kaGain = ctx.createGain();
            kaGain.gain.value = 0.00001;
            kaOsc = ctx.createOscillator();
            kaOsc.type = 'sine';
            kaOsc.frequency.value = 1;
            kaOsc.connect(kaGain);
            kaGain.connect(dest);
            kaOsc.start();
        } catch (e) { /* ignore */ }

        cctx.fillStyle = '#000';
        cctx.fillRect(0, 0, comp.width, comp.height);
        try { drawFrame(cctx, comp, 0, null); } catch (e) { /* ignore */ }
        if (vTrack && typeof vTrack.requestFrame === 'function') {
            try { vTrack.requestFrame(); } catch (e) { /* ignore */ }
        }

        const started = new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn, arg) => {
                if (settled) return;
                settled = true;
                clearTimeout(t);
                clearInterval(poll);
                fn(arg);
            };
            const t = setTimeout(() => {
                try { recorder.stop(); } catch (e) { /* ignore */ }
                stream.getTracks().forEach(tr => { try { tr.stop(); } catch (e) { /* ignore */ } });
                settle(reject, new Error('Perekam tidak mulai (timeout).'));
            }, RECORDER_START_TIMEOUT_MS);
            const poll = setInterval(() => {
                if (recorder.state === 'recording') {
                    settle(resolve);
                    return;
                }
                try { drawFrame(cctx, comp, 0, null); } catch (e) { /* ignore */ }
            }, 80);
            recorder.onstart = () => settle(resolve);
        });

        const name = sanitizeFile((document.getElementById('productNameInput') || {}).value || 'naskah');
        let stopped = false;
        let run = null;
        let watchdog = 0;
        let exportTimer = 0;

        const finish = () => {
            if (stopped) return; stopped = true;
            if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
            if (exportTimer) { clearTimeout(exportTimer); exportTimer = 0; }
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
            if (run) run.stop();
            if (kaOsc) { try { kaOsc.stop(); } catch (e) { /* ignore */ } }
            if (recorder.state === 'recording') {
                try { recorder.requestData(); } catch (e) { /* ignore */ }
                try { recorder.stop(); } catch (e) { resolveDone(); }
                setTimeout(() => resolveDone(), 1500);
            } else {
                resolveDone();
            }
            restoreVisualAfterPlayback();
        };

        recorder.start(200);
        await started;
        await resumeAudioCtx(ctx);
        if (_playToken !== myTok || stopped) { finish(); return; }

        run = scheduleScenes(ctx, [dest], LEAD_IN_S);
        const clock = createRunClock(ctx, run);
        let videoStarted = false;

        watchdog = setTimeout(finish, (LEAD_IN_S + run.timeline.total + 5) * 1000);

        const frameMs = 1000 / EXPORT_FPS;
        let lastFrameAt = 0;
        let lastPct = -1;
        function scheduleNextTick() {
            if (stopped || _playToken !== myTok) return;
            if (exportTimer) clearTimeout(exportTimer);
            exportTimer = setTimeout(draw, Math.max(8, Math.floor(frameMs / 2)));
            if (_rafId) cancelAnimationFrame(_rafId);
            _rafId = requestAnimationFrame(draw);
        }
        function draw() {
            if (_playToken !== myTok || stopped) { finish(); return; }
            const elapsed = clock();
            if (elapsed >= run.timeline.total) { setTimeout(finish, 250); return; }
            const now = performance.now();
            if (now - lastFrameAt < frameMs - 1) {
                scheduleNextTick();
                return;
            }
            lastFrameAt = now;

            const pct = Math.min(99, Math.max(0, Math.round((elapsed / Math.max(1, run.timeline.total)) * 100)));
            if (pct !== lastPct && pct % 10 === 0) {
                lastPct = pct;
                setBusy(true, `Merekam ${pct}%…`);
            }

            const segIdx = subtitleIndexAt(run.timeline.segments, Math.max(0, elapsed));
            const seg = segIdx >= 0 ? run.timeline.segments[segIdx] : null;
            const sceneIdx = segIdx >= 0 ? run.timeline.segments[segIdx].index : (run.timeline.segments[0] || {}).index || 0;
            const t = Math.max(0, elapsed);
            const cue = seg ? subtitleCueAt(seg.cues, t) : null;
            const sub = seg ? { cue, word: activeSubtitleWord(cue, t) } : null;

            if (vis.type === 'video' && vis.el) {
                if (!videoStarted && t > 0) {
                    videoStarted = true;
                    try { vis.el.play(); } catch (e) { /* ignore */ }
                } else if (videoStarted) {
                    syncVisualToClock(vis.el, t, VISUAL_DRIFT_TOL_EXPORT_S);
                }
            }
            try {
                drawFrame(cctx, comp, sceneIdx, sub);
                if (vTrack && typeof vTrack.requestFrame === 'function') {
                    try { vTrack.requestFrame(); } catch (e) { /* ignore */ }
                }
            } catch (err) {
                if (err && err.name === 'SecurityError') {
                    finish();
                    showToast('Format video tidak didukung untuk penggabungan langsung. Silakan gunakan opsi unduh .SRT.', 'error');
                    return;
                }
            }
            scheduleNextTick();
        }
        draw();

        await done;
        stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* ignore */ } });

        const blob = new Blob(chunks, { type: actualMime });
        if (!blob.size) {
            showToast('Gagal memproses video gabungan. Silakan unduh naskah .SRT.', 'error');
            return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ext = actualMime.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
        a.href = url; a.download = `VO_${name}_${Date.now()}.${ext}`; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => { try { document.body.removeChild(a); } catch (e) { /* ignore */ } URL.revokeObjectURL(url); }, 4000);
        showToast('Video (VO + subtitle) berhasil diunduh!', 'success');
    } catch (e) {
        console.error('Export video error:', e);
        showToast('Pembuatan video belum berhasil. Silakan coba lagi atau unduh .SRT.', 'error');
    } finally {
        resetPlayBtn();
        setBusy(false);
        restoreVisualAfterPlayback();
    }
}

function pickWebmMime() {
    const cands = [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4'
    ];
    for (const m of cands) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
}

function buildSubtitleCues(text, start, end) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const weights = words.map(w => Math.max(1, w.length) + (/[,.;:!?]$/.test(w) ? SUB_PAUSE_WEIGHT : 0));
    const total = weights.reduce((a, b) => a + b, 0);
    const dur = Math.max(0.001, end - start);
    let acc = 0;
    const timed = words.map((w, i) => {
        const s = start + (acc / total) * dur;
        acc += weights[i];
        return { text: w, start: s, end: start + (acc / total) * dur };
    });
    const cues = [];
    for (let i = 0; i < timed.length; i += SUB_WORDS_PER_CUE) {
        const chunk = timed.slice(i, i + SUB_WORDS_PER_CUE);
        cues.push({ start: chunk[0].start, end: chunk[chunk.length - 1].end, words: chunk });
    }
    return cues;
}

function subtitleCueAt(cues, t) {
    const list = cues || [];
    for (let i = 0; i < list.length; i++) {
        if (t >= list[i].start && t < list[i].end) return list[i];
    }
    return null;
}

function activeSubtitleWord(cue, t) {
    if (!cue) return null;
    let cur = cue.words[0] || null;
    for (const w of cue.words) { if (t >= w.start) cur = w; else break; }
    return cur;
}

function drawFrame(cctx, comp, idx, sub) {
    const vis = getVisualSource();
    cctx.fillStyle = '#000'; cctx.fillRect(0, 0, comp.width, comp.height);
    if (vis.type === 'video' && vis.el && (vis.el.readyState >= 2 || vis.el.videoWidth > 0)) {
        try { drawCover(cctx, vis.el, comp.width, comp.height); } catch (e) { /* ignore */ }
    }
    drawSubtitle(cctx, comp, sub);
}

function drawSubtitle(cctx, comp, sub) {
    if (!subtitlesEnabled()) return;
    const cue = sub && sub.cue;
    if (!cue || !cue.words.length) return;
    cctx.font = `800 ${SUB_FONT_PX}px Inter, sans-serif`;
    cctx.textAlign = 'left'; cctx.textBaseline = 'alphabetic';
    cctx.lineJoin = 'round'; cctx.miterLimit = 2;
    cctx.lineWidth = SUB_STROKE_PX; cctx.strokeStyle = 'rgba(0,0,0,0.75)';
    const space = cctx.measureText(' ').width;
    const words = cue.words.map(w => ({ ref: w, text: w.text, width: cctx.measureText(w.text).width }));
    const lines = wrapCueWords(words, space, SUB_MAX_WIDTH);
    let y = comp.height - SUB_BOTTOM_PAD - (lines.length - 1) * SUB_LINE_H;
    for (const line of lines) {
        const lineW = line.reduce((s, w) => s + w.width, 0) + space * (line.length - 1);
        let x = (comp.width - lineW) / 2;
        for (const w of line) {
            cctx.strokeText(w.text, x, y);
            cctx.fillStyle = (sub.word && w.ref === sub.word) ? SUB_COLOR_ACTIVE : SUB_COLOR_IDLE;
            cctx.fillText(w.text, x, y);
            x += w.width + space;
        }
        y += SUB_LINE_H;
    }
}

function drawCover(cctx, el, w, h) {
    const sw = el.videoWidth || el.width || 0;
    const sh = el.videoHeight || el.height || 0;
    if (sw <= 0 || sh <= 0) return;
    const scale = Math.max(w / sw, h / sh);
    const dw = sw * scale, dh = sh * scale;
    cctx.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function roundRect(cctx, x, y, w, h, r) {
    cctx.beginPath();
    cctx.moveTo(x + r, y); cctx.arcTo(x + w, y, x + w, y + h, r); cctx.arcTo(x + w, y + h, x, y + h, r);
    cctx.arcTo(x, y + h, x, y, r); cctx.arcTo(x, y, x + w, y, r); cctx.closePath();
}

function wrapCueWords(words, space, maxW) {
    const lines = []; let line = []; let w = 0;
    for (const it of words) {
        const add = line.length ? space + it.width : it.width;
        if (line.length && w + add > maxW) { lines.push(line); line = [it]; w = it.width; }
        else { line.push(it); w += add; }
    }
    if (line.length) lines.push(line);
    return lines.slice(0, SUB_MAX_LINES);
}

function sanitizeFile(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'naskah';
}

(function wireSubtitleToggle() {
    const cb = document.getElementById('subtitleCheckbox');
    if (!cb) return;
    cb.addEventListener('change', () => {
        if (!isPlayingMerged) return;
        const on = subtitlesEnabled();
        const el = document.getElementById('subtitleOverlayContainer');
        if (el) el.classList.toggle('hidden', !on);
        if (!on) clearSubtitleText();
    });
})();
