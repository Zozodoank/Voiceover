// public/js/audio-engine.js - Mesin audio TTS Gemini murni:
// 1 video = 1 kali panggil TTS Gemini untuk seluruh naskah video.
// Audio disimpan di memori untuk pratinjau instan, pemutaran sinkron, pemotongan per adegan,
// dan perekaman ekspor video WebM/MP4 nyata (kanvas + audio + subtitle burn-in).
// Classic script: memakai global (generatedScenesData, sceneAudios, getSelectedVoice,
// getVisualSource, showToast, apiFetch).

let _audioCtx = null;
let _playToken = 0;             // pembatalan playback aktif
let _activeSources = [];        // AudioBufferSourceNode aktif agar bisa dihentikan
let _rafId = 0;
let _videoAudio = null;         // { buffer, duration, blobUrl, sig }
let _videoAudioInflight = null; // promise fetch aktif untuk cegah panggilan ganda
let _scenePreviewAudio = null;  // source aktif tombol "Dengar"
let _lastClockLabel = '';

const EXPORT_W = 1080, EXPORT_H = 1920, EXPORT_FPS = 30;

// Subtitle burn-in
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
const VISUAL_DRIFT_TOL_S = 0.15;
const VISUAL_DRIFT_TOL_EXPORT_S = 0.2;
const LEAD_IN_S = 0.35;
const SILENCE_RATIO = 0.006;
const TRIM_PAD_S = 0.06;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Tier kualitas terpilih (id netral). */
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

function audioCtx() {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') {
        try { _audioCtx.resume(); } catch (e) { /* ignore */ }
    }
    return _audioCtx;
}

/** Signature video audio: versi + voice + tier + isi naskah gabungan. */
function videoAudioSignature() {
    const v = (typeof getSelectedVoice === 'function') ? getSelectedVoice().name : 'Kore';
    const tier = getSelectedTier();
    const scenes = generatedScenesData || [];
    const text = scenes.map(s => (s.text || '').trim()).filter(Boolean).join(' ');
    return SCRIPT_VERSION + '|' + v + '|' + tier + '|' + text;
}

/** Decode audio blob menjadi AudioBuffer. */
async function decodeAudioBlob(blob) {
    const ctx = audioCtx();
    if (ctx && ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (e) { /* ignore */ }
    }
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
 * Panggil POST /api/tts/preview: HANYA 1 KALI PER VIDEO untuk naskah lengkap.
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

/**
 * Buang keheningan awal/akhir hasil TTS.
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

/**
 * 1 VIDEO = 1 PANGGILAN TTS GEMINI.
 * Menggabungkan naskah seluruh adegan menjadi satu dan memanggil Gemini TTS sekali.
 * Hasil disimpan di _videoAudio dan di-cache dalam memori.
 */
async function ensureVideoAudio(onProgress) {
    if (_videoAudioInflight) {
        return await _videoAudioInflight;
    }
    const sig = videoAudioSignature();
    if (_videoAudio && _videoAudio.sig === sig && _videoAudio.buffer) {
        return _videoAudio;
    }

    const scenes = generatedScenesData || [];
    if (!scenes.length) throw new Error('Naskah video belum tersedia.');
    const fullScript = scenes.map(s => (s.text || '').trim()).filter(Boolean).join(' ');
    if (!fullScript) throw new Error('Teks naskah video kosong.');

    const vName = (typeof getSelectedVoice === 'function') ? getSelectedVoice().name : 'Kore';
    const tier = getSelectedTier() || 'tier-normal';
    const primaryEmotion = (scenes[0] && scenes[0].emotion) || 'Antusias';

    if (typeof onProgress === 'function') {
        try { onProgress(1, 1); } catch (e) { /* ignore */ }
    }

    _videoAudioInflight = (async () => {
        try {
            const raw = await fetchPreviewBuffer(vName, fullScript, primaryEmotion, tier);
            const buf = trimSilence(raw.buffer);
            if (_videoAudio && _videoAudio.blobUrl) {
                try { URL.revokeObjectURL(_videoAudio.blobUrl); } catch (e) { /* ignore */ }
            }
            _videoAudio = {
                buffer: buf,
                duration: buf.duration,
                blobUrl: raw.blobUrl,
                sig: sig
            };
            // Sinkronkan ke array sceneAudios untuk kompatibilitas
            sceneAudios = scenes.map(s => ({
                buffer: buf,
                duration: buf.duration,
                blobUrl: raw.blobUrl,
            }));
            sceneAudiosKey = sig;
            return _videoAudio;
        } finally {
            _videoAudioInflight = null;
        }
    })();

    return await _videoAudioInflight;
}

/** Alias untuk kompatibilitas kode lain (studio.js / playback.js). */
async function ensureSceneAudios(onProgress) {
    return await ensureVideoAudio(onProgress);
}

/** Batalkan cache audio saat video atau naskah berganti. */
function invalidateSceneAudios() {
    _videoAudioInflight = null;
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

/** Validasi audio sebelum diputar/diekspor. */
function assertAllAudio() {
    if (!_videoAudio || !_videoAudio.buffer) {
        throw new Error('Suara video belum siap.');
    }
}

/**
 * Satu-satunya sumber timeline untuk pratinjau, burn-in, ekspor, dan .SRT.
 */
function buildTimeline() {
    const list = generatedScenesData || [];
    const videoTotal = getVideoDurationS();
    const audioTotal = (_videoAudio && _videoAudio.duration) || 0;
    const totalDuration = Math.max(videoTotal, audioTotal, 1);

    // Hitung jendela per adegan
    const segments = [];
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        let st = Number(s && s.start);
        let en = Number(s && s.end);
        if (!Number.isFinite(st) || st < 0) st = (i * totalDuration) / Math.max(1, list.length);
        if (!Number.isFinite(en) || en <= st) en = ((i + 1) * totalDuration) / Math.max(1, list.length);

        // Skala proporsional bila audio lebih panjang dari durasi video
        if (audioTotal > videoTotal && videoTotal > 0) {
            const scale = audioTotal / videoTotal;
            st = st * scale;
            en = en * scale;
        }

        segments.push({
            index: i,
            start: st,
            end: en,
            dur: en - st,
            text: (s && s.text) || '',
            emotion: (s && s.emotion) || '',
            cues: buildSubtitleCues((s && s.text) || '', st, en),
        });
    }

    return {
        segments,
        total: totalDuration,
        videoDuration: videoTotal,
        audioDuration: audioTotal
    };
}

// Dipakai playback.js / studio.js untuk ekspor .SRT yang sinkron
window.getSceneTimeline = () => buildTimeline();

/** True bila waktu berada di dalam jendela bicara adegan tsb. */
function subtitleIndexAt(segments, elapsed) {
    for (let i = 0; i < segments.length; i++) {
        if (elapsed >= segments[i].start && elapsed < segments[i].end) return i;
    }
    return -1;
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
 * Putar cuplikan satu adegan dari buffer audio yang sudah ada di memori.
 * ZERO API REQUESTS: langsung memotong segmen dari _videoAudio.buffer.
 */
function playCachedSceneAudio(idx) {
    if (!_videoAudio || !_videoAudio.buffer) return false;
    const scene = (generatedScenesData || [])[idx];
    if (!scene) return false;

    const timeline = buildTimeline();
    const seg = (timeline.segments || []).find(s => s.index === idx);
    const start = seg ? seg.start : (Number(scene.start) || 0);
    const end = seg ? seg.end : (Number(scene.end) || start + 3);
    const dur = Math.max(0.5, end - start);

    if (_scenePreviewAudio) {
        try {
            if (typeof _scenePreviewAudio.stop === 'function') _scenePreviewAudio.stop();
            else if (typeof _scenePreviewAudio.pause === 'function') _scenePreviewAudio.pause();
        } catch (e) { /* ignore */ }
        _scenePreviewAudio = null;
    }

    const ctx = audioCtx();
    const src = ctx.createBufferSource();
    src.buffer = _videoAudio.buffer;
    src.connect(ctx.destination);
    src.start(0, start, dur);
    _scenePreviewAudio = src;
    return true;
}

/** Perbarui overlay pratinjau subtitle + badge adegan. */
function updateOverlayDOM(sceneIdx, sub) {
    const scene = (generatedScenesData || [])[sceneIdx] || {};
    const badge = document.getElementById('currentSceneBadgeText');
    if (badge && sceneIdx >= 0) badge.innerText = `Adegan ${sceneIdx + 1}: ${scene.emotion || ''}`;
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
 * Mulai pemutaran gabungan tersinkron (video + 1 trek audio Gemini TTS + subtitle).
 */
async function startMergedPlayback() {
    await ensureVideoAudio();
    assertAllAudio();
    if (!generatedScenesData || !generatedScenesData.length) return;

    stopEverything();
    const myTok = ++_playToken;
    const ctx = audioCtx(); ctx._tok = myTok;

    const timeline = buildTimeline();
    const scheduledAt = ctx.currentTime;
    const scheduledWall = performance.now();
    const startTime = scheduledAt + 0.1;

    // 1 source tunggal memainkan trek audio Gemini lengkap dari awal hingga selesai
    const srcNode = ctx.createBufferSource();
    srcNode.buffer = _videoAudio.buffer;
    srcNode.connect(ctx.destination);
    srcNode.start(startTime);
    _activeSources = [srcNode];

    const run = {
        startTime,
        scheduledAt,
        scheduledWall,
        timeline,
        stop: () => {
            _activeSources.forEach(s => { try { s.stop && s.stop(); } catch (e) { /* ignore */ } });
            _activeSources = [];
        }
    };

    const clock = createRunClock(ctx, run);
    const src = getVisualSource();
    if (src.type === 'video') {
        try { src.el.loop = false; src.el.muted = true; src.el.currentTime = 0; await src.el.play(); } catch (e) { /* autoplay */ }
    }

    const subOn = subtitlesEnabled();
    document.getElementById('subtitleOverlayContainer').classList.toggle('hidden', !subOn);
    document.getElementById('sceneOverlayBadge').classList.toggle('hidden', !subOn);
    paintPlaybackClock(0, timeline.total);

    let lastKey = '';
    (function loop() {
        if (_playToken !== myTok) return;
        const elapsed = clock();
        if (elapsed >= timeline.total) {
            stopEverything();
            if (typeof resetPlayBtn === 'function') resetPlayBtn();
            return;
        }
        if (src.type === 'video') syncVisualToClock(src.el, elapsed, VISUAL_DRIFT_TOL_S);
        paintPlaybackClock(elapsed, timeline.total);

        const idx = subtitleIndexAt(timeline.segments, elapsed);
        const seg = idx >= 0 ? timeline.segments[idx] : null;
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
 * Ekspor video WebM/MP4 nyata: rekaman kanvas 30fps + audio Gemini + burn-in subtitle.
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
    if (!navigator.mediaDevices || !HTMLCanvasElement.prototype.captureStream) {
        showToast('Pembuatan video tidak didukung pada browser ini. Silakan gunakan opsi unduh .SRT.', 'error');
        return;
    }

    const setBusy = (busy, text) => {
        if (btn) btn.disabled = busy;
        if (label) label.innerText = busy ? (text || 'Merekam…') : 'Unduh';
    };

    const ctx = audioCtx();
    if (ctx && ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (e) { /* ignore */ }
    }

    setBusy(true, 'Menyiapkan suara…');
    stopEverything();
    try {
        await ensureVideoAudio();
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
        dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));

        const chunks = [];
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

        const done = new Promise((resolve) => { recorder.onstop = resolve; });
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
                if (recorder.state === 'recording') settle(resolve);
            }, 100);
            recorder.onstart = () => settle(resolve);
        });

        const name = sanitizeFile((document.getElementById('productNameInput') || {}).value || 'naskah');
        let stopped = false;
        let srcNode = null;
        let kaOsc = null;
        let watchdog = 0;

        const finish = () => {
            if (stopped) return; stopped = true;
            if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
            if (_rafId) cancelAnimationFrame(_rafId);
            if (srcNode) { try { srcNode.stop(); } catch (e) { /* ignore */ } }
            if (kaOsc) { try { kaOsc.stop(); } catch (e) { /* ignore */ } }
            try { recorder.stop(); } catch (e) { /* ignore */ }
            stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* ignore */ } });
            restoreVisualAfterPlayback();
        };

        const vis = getVisualSource();
        if (vis.type === 'video') { try { vis.el.loop = false; vis.el.muted = true; } catch (e) { /* ignore */ } }

        cctx.fillStyle = '#000';
        cctx.fillRect(0, 0, comp.width, comp.height);

        recorder.start(200);
        await started;
        if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* ignore */ } }
        if (_playToken !== myTok || stopped) { finish(); return; }

        const timeline = buildTimeline();
        const scheduledAt = ctx.currentTime;
        const scheduledWall = performance.now();
        const startTime = scheduledAt + LEAD_IN_S;

        srcNode = ctx.createBufferSource();
        srcNode.buffer = _videoAudio.buffer;
        srcNode.connect(dest);
        srcNode.start(startTime);
        _activeSources = [srcNode];

        const run = {
            startTime,
            scheduledAt,
            scheduledWall,
            timeline,
            stop: finish
        };
        const clock = createRunClock(ctx, run);
        if (vis.type === 'video') { try { vis.el.currentTime = 0; await vis.el.play(); } catch (e) { /* ignore */ } }

        watchdog = setTimeout(finish, (LEAD_IN_S + timeline.total + 5) * 1000);

        const kaGain = ctx.createGain(); kaGain.gain.value = 0;
        kaOsc = ctx.createOscillator(); kaOsc.type = 'sine'; kaOsc.frequency.value = 1;
        kaOsc.connect(kaGain); kaGain.connect(dest);
        kaOsc.start(run.startTime); kaOsc.stop(run.startTime + timeline.total + 0.5);

        const frameMs = 1000 / EXPORT_FPS;
        let lastFrameAt = 0;
        (function draw() {
            if (_playToken !== myTok) { finish(); return; }
            const elapsed = clock();
            if (elapsed >= timeline.total) { setTimeout(finish, 250); return; }
            const now = performance.now();
            if (now - lastFrameAt < frameMs - 1) { _rafId = requestAnimationFrame(draw); return; }
            lastFrameAt = now;

            const segIdx = subtitleIndexAt(timeline.segments, Math.max(0, elapsed));
            const seg = segIdx >= 0 ? timeline.segments[segIdx] : null;
            const sceneIdx = segIdx >= 0 ? timeline.segments[segIdx].index : 0;
            const t = Math.max(0, elapsed);
            const cue = seg ? subtitleCueAt(seg.cues, t) : null;
            const sub = seg ? { cue, word: activeSubtitleWord(cue, t) } : null;

            if (vis.type === 'video') syncVisualToClock(vis.el, t, VISUAL_DRIFT_TOL_EXPORT_S);
            try {
                drawFrame(cctx, comp, sceneIdx, sub);
            } catch (err) {
                if (err && err.name === 'SecurityError') {
                    finish();
                    showToast('Format video tidak didukung untuk penggabungan langsung. Silakan gunakan opsi unduh .SRT.', 'error');
                    return;
                }
            }
            _rafId = requestAnimationFrame(draw);
        })();

        await done;
        const blob = new Blob(chunks, { type: mimeType });
        if (!blob.size) {
            showToast('Gagal memproses video gabungan. Silakan unduh naskah .SRT.', 'error');
            return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ext = mimeType.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
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
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
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
    const scene = (generatedScenesData || [])[idx] || {};
    const vis = getVisualSource();
    cctx.fillStyle = '#000'; cctx.fillRect(0, 0, comp.width, comp.height);
    if (vis.type === 'video' && vis.el && vis.el.readyState >= 2) {
        drawCover(cctx, vis.el, comp.width, comp.height);
    }
    cctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(cctx, 24, 24, 520, 64, 32); cctx.fill();
    cctx.fillStyle = '#fff'; cctx.font = 'bold 32px Inter, sans-serif'; cctx.textAlign = 'left'; cctx.textBaseline = 'middle';
    cctx.fillText(`Adegan ${idx + 1}: ${scene.emotion || ''}`, 40, 56);
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
        ['subtitleOverlayContainer', 'sceneOverlayBadge'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('hidden', !on);
        });
        if (!on) clearSubtitleText();
    });
})();
