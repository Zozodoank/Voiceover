// public/js/audio-engine.js - Mesin audio TTS: prerender per adegan (berurutan agar kuota tidak jebol),
// satu timeline dari durasi audio ASLI, playback tersinkron, dan ekspor video WebM nyata
// (kanvas kompositor + MediaRecorder + audio mix + subtitle burn-in).
// Classic script: memakai global (generatedScenesData, sceneAudios, getSelectedVoice,
// getVisualSource, showToast, apiFetch).

let _audioCtx = null;
let _playToken = 0;          // pembatalan playback aktif (klik Putar/Jeda/Rekam saat diputar)
let _activeSources = [];     // AudioBufferSourceNode aktif agar bisa dihentikan
let _rafId = 0;
let _prerenderInflight = null; // promise prerender aktif (hindari panggilan ganda)

const EXPORT_W = 1080, EXPORT_H = 1920, EXPORT_FPS = 30;
// Batas tunggu event `start` MediaRecorder. Video 4K + encoder software bisa butuh beberapa detik
// untuk menyala; watchdog terlalu ketat membuat ekspor gagal padahal perekam hanya terlambat.
const RECORDER_START_TIMEOUT_MS = 15000;

const SCRIPT_VERSION = 'v2';   // naikkan bila strategi TTS berubah: memaksa prerender ulang
const SCENE_GAP_S = 0.18;      // jeda antar adegan pada timeline
const LEAD_IN_S = 0.35;        // audio mulai setelah perekaman benar-benar berjalan
const PACE_MS = 350;           // jeda antar panggilan TTS (hindari 429)
const SCENE_RETRIES = 2;
const SILENCE_RATIO = 0.006;   // ambang keheningan relatif terhadap peak
const TRIM_PAD_S = 0.06;       // sisa padding setelah pemangkasan keheningan

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Tier kualitas terpilih (id netral; model dipilih server). */
function getSelectedTier() {
    const r = document.querySelector('input[name="ttsModel"]:checked');
    return r ? r.value : '';
}

function audioCtx() {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    return _audioCtx;
}

/** Signature voice + tier + isi naskah (deteksi perlu prerender ulang tidak). */
function sceneAudioSignature() {
    const v = (typeof getSelectedVoice === 'function') ? getSelectedVoice().name : '';
    return SCRIPT_VERSION + '|' + v + '|' + getSelectedTier() + '|'
        + (generatedScenesData || []).map(s => (s.emotion || '') + '#' + (s.text || '')).join('|');
}

/** Ambil satu cuplikan TTS sebagai AudioBuffer (plus blobUrl). Melempar error bila gagal. */
async function fetchPreviewBuffer(voiceName, text, emotion, tier) {
    const res = await fetch('/api/tts/preview', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceName, text, emotion: emotion || undefined, tier: tier || undefined }),
    });
    const ct = res.headers.get('Content-Type') || '';
    if (!res.ok || ct.indexOf('audio') === -1) throw new Error('tts_' + res.status);
    const blob = await res.blob();
    const buf = await audioCtx().decodeAudioData(await blob.arrayBuffer());
    return { buffer: buf, duration: buf.duration, blobUrl: URL.createObjectURL(blob) };
}

/** Satu adegan dengan percobaan ulang (429 = kuota -> tunggu lebih lama; 4xx lain tidak akan berhasil). */
async function fetchSceneAudioWithRetry(voiceName, text, emotion, tier) {
    let lastErr = null;
    for (let attempt = 0; attempt <= SCENE_RETRIES; attempt++) {
        try {
            return await fetchPreviewBuffer(voiceName, text, emotion, tier);
        } catch (e) {
            lastErr = e;
            const code = Number((String((e && e.message) || '').match(/tts_(\d{3})/) || [])[1] || 0);
            const permanent = code >= 400 && code < 500 && code !== 429;
            if (permanent || attempt === SCENE_RETRIES) break;
            await sleep(code === 429 ? 2500 * (attempt + 1) : 800 * (attempt + 1));
        }
    }
    throw lastErr;
}

/**
 * Buang keheningan awal/akhir hasil TTS. Gemini menambahkan jeda yang membuat subtitle
 * tampak terlambat; memangkasnya membuat teks muncul tepat saat suara mulai.
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

/** Buat audio untuk SEMUA adegan secara BERURUTAN (kuota Gemini TTS terbatas). */
async function prerenderSceneAudios(onProgress) {
    const scenes = generatedScenesData || [];
    const vName = (typeof getSelectedVoice === 'function') ? getSelectedVoice().name : 'Kore';
    const tier = getSelectedTier();
    const sig = sceneAudioSignature();

    (sceneAudios || []).forEach(a => { if (a && a.blobUrl) { try { URL.revokeObjectURL(a.blobUrl); } catch (e) { /* ignore */ } } });
    sceneAudios = new Array(scenes.length).fill(null);
    sceneAudiosKey = ''; // tandai belum siap sampai selesai

    let fail = 0;
    for (let i = 0; i < scenes.length; i++) {
        try {
            const raw = await fetchSceneAudioWithRetry(vName, scenes[i].text, scenes[i].emotion, tier);
            const buf = trimSilence(raw.buffer);
            sceneAudios[i] = { buffer: buf, duration: buf.duration, blobUrl: raw.blobUrl };
        } catch (e) {
            sceneAudios[i] = null; fail++;
        }
        if (typeof onProgress === 'function') {
            try { onProgress(i + 1, scenes.length); } catch (e) { /* ignore */ }
        }
        if (i < scenes.length - 1) await sleep(PACE_MS);
    }
    sceneAudiosKey = fail ? '' : sig; // ada adegan gagal -> tanda BELUM siap agar percobaan berikutnya benar-benar mengulang
    return { ok: scenes.length - fail, fail };
}

/** Pastikan sceneAudios cocok dengan naskah/voice/tier terpilih; prerender bila perlu. */
async function ensureSceneAudios(onProgress) {
    if (_prerenderInflight) { await _prerenderInflight; return; }
    const sig = sceneAudioSignature();
    const complete = sceneAudios.length === (generatedScenesData || []).length && sceneAudios.length > 0;
    if (sceneAudiosKey === sig && complete && !missingSceneNumbers().length) return;
    _prerenderInflight = prerenderSceneAudios(onProgress).then((r) => { _prerenderInflight = null; return r; })
        .catch((e) => { _prerenderInflight = null; throw e; });
    await _prerenderInflight;
}

/** Nomor adegan (1-based) yang audionya belum ada. */
function missingSceneNumbers() {
    const out = [];
    (generatedScenesData || []).forEach((s, i) => {
        const a = sceneAudios[i];
        if (!a || !a.buffer) out.push(i + 1);
    });
    return out;
}

/** Suara wajib lengkap: tanpa audio, subtitle/ekspor tidak mungkin sinkron. */
function assertAllAudio() {
    const missing = missingSceneNumbers();
    if (missing.length) throw new Error('audio_missing:' + missing.join(','));
}

/**
 * Timeline tunggal dari durasi audio ASLI: dipakai playback, burn-in, dan ekspor .SRT.
 * -> { segments:[{ index, start, end, dur, text, emotion }], total }
 */
function buildTimeline() {
    const scenes = generatedScenesData || [];
    const segments = [];
    let cursor = 0;
    for (let i = 0; i < scenes.length; i++) {
        const a = sceneAudios[i];
        if (!a || !a.buffer) continue;
        const dur = Math.max(0.2, a.duration || a.buffer.duration);
        segments.push({
            index: i,
            start: cursor,
            end: cursor + dur,
            dur,
            text: scenes[i].text || '',
            emotion: scenes[i].emotion || '',
        });
        cursor += dur + SCENE_GAP_S;
    }
    const total = segments.length ? segments[segments.length - 1].end : 0;
    return { segments, total };
}

// Dipakai playback.js / studio.js: SRT & daftar adegan memakai timeline yang SAMA dengan playback.
window.getSceneTimeline = () => buildTimeline();

/** True bila waktu berada di dalam jendela bicara adegan tsb (jeda = tanpa subtitle). */
function subtitleIndexAt(segments, elapsed) {
    for (let i = 0; i < segments.length; i++) {
        if (elapsed >= segments[i].start && elapsed < segments[i].end) return i;
    }
    return -1;
}

/** Jadwalkan seluruh adegan berurutan pada ctx. Melempar bila ada audio yang hilang. */
function scheduleScenes(ctx, destNodes, leadIn) {
    assertAllAudio();
    const timeline = buildTimeline();
    const startTime = ctx.currentTime + (Number.isFinite(leadIn) && leadIn >= 0 ? leadIn : 0.08);
    _activeSources = [];
    timeline.segments.forEach((seg) => {
        const a = sceneAudios[seg.index];
        const src = ctx.createBufferSource();
        src.buffer = a.buffer;
        destNodes.forEach(d => src.connect(d));
        src.start(startTime + seg.start);
        _activeSources.push(src);
    });
    return {
        startTime,
        timeline,
        stop: () => { _activeSources.forEach(s => { try { s.stop && s.stop(); } catch (e) { /* ignore */ } }); },
    };
}

function updateOverlayDOM(sceneIdx) {
    const scene = (generatedScenesData || [])[sceneIdx] || {};
    const sub = document.getElementById('subtitleOverlayText');
    const badge = document.getElementById('currentSceneBadgeText');
    if (sub) sub.innerText = scene.text || '';
    if (badge) badge.innerText = `Adegan ${sceneIdx + 1}: ${scene.emotion || ''}`;
}

function clearSubtitleText() {
    const sub = document.getElementById('subtitleOverlayText');
    if (sub) sub.innerText = '';
}

function stopEverything() {
    _playToken++;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
    _activeSources.forEach(s => { try { s.stop && s.stop(); } catch (e) { /* ignore */ } });
    _activeSources = [];
    const v = document.getElementById('mainVideo');
    if (v && !v.paused) { try { v.pause(); } catch (e) { /* ignore */ } }
    ['subtitleOverlayContainer', 'sceneOverlayBadge'].forEach(id => {
        const el = document.getElementById(id); if (el) el.classList.add('hidden');
    });
}

/** Mulai playback gabungan tersinkron audio asli (sumber visual: video/kanvas). */
async function startMergedPlayback() {
    await ensureSceneAudios();
    assertAllAudio();
    if (!generatedScenesData || !generatedScenesData.length) return;
    stopEverything();
    const myTok = ++_playToken;
    const ctx = audioCtx(); ctx._tok = myTok;

    // Siapkan visual
    const src = getVisualSource();
    if (src.type === 'video') { try { src.el.currentTime = 0; src.el.muted = true; src.el.loop = true; await src.el.play(); } catch (e) { /* autoplay */ } }
    document.getElementById('subtitleOverlayContainer').classList.remove('hidden');
    document.getElementById('sceneOverlayBadge').classList.remove('hidden');

    const run = scheduleScenes(ctx, [ctx.destination], 0.12);
    let lastIdx = -2;
    (function loop() {
        if (_playToken !== myTok) return;
        const elapsed = ctx.currentTime - run.startTime;
        if (elapsed >= run.timeline.total) { stopEverything(); resetPlayBtn && resetPlayBtn(); return; }
        const idx = subtitleIndexAt(run.timeline.segments, elapsed);
        if (idx !== lastIdx) {
            if (idx >= 0) updateOverlayDOM(run.timeline.segments[idx].index);
            else clearSubtitleText();
            lastIdx = idx;
        }
        _rafId = requestAnimationFrame(loop);
    })();
}

function resetPlayBtn() {
    const t = document.getElementById('playMergedText'); const ic = document.getElementById('playMergedIcon');
    if (t) t.innerText = 'Putar'; if (ic) ic.className = 'fa-solid fa-play';
    isPlayingMerged = false;
}

/** ==== Ekspor WebM nyata: kanvas kompositor + audio mix + burn subtitle ==== */
async function exportMergedVideoWebM() {
    const btn = document.getElementById('exportMergedBtn');
    const label = document.getElementById('exportBtnLabel');
    if (btn && btn.disabled) return; // cegah klik ganda
    if (!generatedScenesData || !generatedScenesData.length) { showToast('Buat Voice Over dulu sebelum mengunduh.', 'error'); return; }
    if (!window.MediaRecorder) { showToast('Browser tidak mendukung MediaRecorder. Pakai unduh .SRT.', 'error'); return; }
    if (!navigator.mediaDevices || !HTMLCanvasElement.prototype.captureStream) {
        showToast('Ekspor video tidak didukung di browser ini. Pakai unduh .SRT.', 'error'); return;
    }

    const setBusy = (busy, text) => {
        if (btn) btn.disabled = busy;
        if (label) label.innerText = busy ? (text || 'Merekam…') : 'Unduh';
    };

    setBusy(true, 'Menyiapkan suara…');
    stopEverything();
    try {
        await ensureSceneAudios((done, total) => setBusy(true, `Suara ${done}/${total}…`));
        assertAllAudio();
        setBusy(true, 'Merekam…');

        const mimeType = pickWebmMime();
        if (!mimeType) throw new Error('Format WebM tidak didukung browser.');

        // Kanvas kompositor
        const comp = document.createElement('canvas'); comp.width = EXPORT_W; comp.height = EXPORT_H;
        const cctx = comp.getContext('2d');

        const ctx = audioCtx();
        const dest = ctx.createMediaStreamDestination();
        const myTok = ++_playToken; ctx._tok = myTok;

        // Video track dari kanvas; audio track dari destination; gabung
        const stream = comp.captureStream(EXPORT_FPS);
        dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));

        const chunks = [];
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

        const done = new Promise((resolve) => { recorder.onstop = resolve; });
        // Timeout: bila perekam benar-benar tidak mau jalan, tombol Unduh tidak boleh terkunci selamanya.
        // Sebagian browser tidak memancarkan event `start` walau perekam sudah berstatus 'recording'
        // (terlihat saat stream menyertakan track audio dari MediaStreamDestination), jadi status
        // perekam ikut dipantau - bukan hanya menunggu event.
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
        let run = null;
        let kaOsc = null;
        const finish = () => {
            if (stopped) return; stopped = true;
            if (_rafId) cancelAnimationFrame(_rafId);
            if (run) run.stop();
            if (kaOsc) { try { kaOsc.stop(); } catch (e) { /* ignore */ } }
            try { recorder.stop(); } catch (e) { /* ignore */ }
            stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* ignore */ } });
        };

        // Mulai visual video (muted; audio dari TTS)
        const vis = getVisualSource();
        if (vis.type === 'video') { try { vis.el.currentTime = 0; vis.el.muted = true; vis.el.loop = true; await vis.el.play(); } catch (e) { /* ignore */ } }

        // Rekaman HARUS hidup dulu, baru audio dijadwalkan: kalau dibalik, awal VO terpotong
        // dan seluruh video bergeser (subtitle tampak telat).
        recorder.start(200);
        await started;
        if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* ignore */ } }
        // Dibatalkan pengguna tepat saat perekam menyala: jangan jadwalkan audio ke stream yang sudah mati.
        if (_playToken !== myTok || stopped) { finish(); return; }

        run = scheduleScenes(ctx, [dest], LEAD_IN_S); // audio TTS -> stream, dengan lead-in senyap
        // Sumber senyap (gain 0) menjaga track audio MediaStreamDestination tetap merender selama
        // rekaman. Tanpa ini, saat tidak ada buffer audio, Chrome menulis WebM 0-byte.
        const kaGain = ctx.createGain(); kaGain.gain.value = 0;
        kaOsc = ctx.createOscillator(); kaOsc.type = 'sine'; kaOsc.frequency.value = 1;
        kaOsc.connect(kaGain); kaGain.connect(dest);
        kaOsc.start(run.startTime); kaOsc.stop(run.startTime + run.timeline.total + 0.5);

        (function draw() {
            if (_playToken !== myTok) { finish(); return; }
            const elapsed = ctx.currentTime - run.startTime;
            if (elapsed >= run.timeline.total) { setTimeout(finish, 250); return; }
            const segIdx = subtitleIndexAt(run.timeline.segments, Math.max(0, elapsed));
            const sceneIdx = segIdx >= 0 ? run.timeline.segments[segIdx].index : (run.timeline.segments[0] || {}).index || 0;
            try {
                drawFrame(cctx, comp, sceneIdx, segIdx < 0);
            } catch (err) {
                if (err && err.name === 'SecurityError') { finish(); showToast('Video lintas-origin menodai kanvas (CORS). Ekspor dibatalkan; pakai .SRT.', 'error'); return; }
            }
            _rafId = requestAnimationFrame(draw);
        })();

        await done;
        const blob = new Blob(chunks, { type: 'video/webm' });
        if (!blob.size) {
            showToast('Ekspor menghasilkan file kosong (audio VO tidak tersedia). Coba unduh .SRT saja.', 'error');
            return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `VO_${name}_${Date.now()}.webm`; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => { try { document.body.removeChild(a); } catch (e) { /* ignore */ } URL.revokeObjectURL(url); }, 4000);
        showToast('Video WebM (VO + subtitle) berhasil diunduh!', 'success');
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (msg.indexOf('audio_missing:') === 0) {
            showToast('Suara adegan ' + msg.split(':')[1] + ' gagal dibuat. Tekan Unduh sekali lagi untuk mengulang.', 'error');
        } else {
            showToast('Ekspor gagal: ' + msg + '. Coba unduh .SRT.', 'error');
        }
    } finally {
        resetPlayBtn();
        setBusy(false);
    }
}

function pickWebmMime() {
    const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm'];
    for (const m of cands) { if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m; }
    return '';
}

/** Gambar satu frame kompositor: visual (video/kanvas) + badge emosi + subtitle burn-in. */
function drawFrame(cctx, comp, idx, hideSubtitle) {
    const scene = (generatedScenesData || [])[idx] || {};
    const vis = getVisualSource();
    // dasar hitam
    cctx.fillStyle = '#000'; cctx.fillRect(0, 0, comp.width, comp.height);
    if (vis.type === 'video' && vis.el && vis.el.readyState >= 2) {
        drawCover(cctx, vis.el, comp.width, comp.height);
    }
    // badge adegan (kiri atas) - skala portrait 1080x1920
    cctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(cctx, 24, 24, 520, 64, 32); cctx.fill();
    cctx.fillStyle = '#fff'; cctx.font = 'bold 32px Inter, sans-serif'; cctx.textAlign = 'left'; cctx.textBaseline = 'middle';
    cctx.fillText(`Adegan ${idx + 1}: ${scene.emotion || ''}`, 40, 56);
    // subtitle burn-in (bawah, tengah) - kosong saat jeda antar adegan
    const text = hideSubtitle ? '' : (scene.text || '');
    if (text) {
        cctx.font = '800 60px Inter, sans-serif'; cctx.textAlign = 'center'; cctx.textBaseline = 'alphabetic';
        const lines = wrapText(cctx, text, comp.width - 120);
        let y = comp.height - 120 - (lines.length - 1) * 74;
        for (const ln of lines) {
            cctx.lineWidth = 8; cctx.strokeStyle = 'rgba(0,0,0,0.85)'; cctx.strokeText(ln, comp.width / 2, y);
            cctx.fillStyle = '#fde047'; cctx.fillText(ln, comp.width / 2, y);
            y += 74;
        }
    }
}

/** Gambar sumber video mengisi penuh w×h (crop sisi berlebih), ter-center. */
function drawCover(cctx, el, w, h) {
    const sw = el.videoWidth || el.width || w, sh = el.videoHeight || el.height || h;
    const scale = Math.max(w / sw, h / sh);
    const dw = sw * scale, dh = sh * scale;
    cctx.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function roundRect(cctx, x, y, w, h, r) {
    cctx.beginPath();
    cctx.moveTo(x + r, y); cctx.arcTo(x + w, y, x + w, y + h, r); cctx.arcTo(x + w, y + h, x, y + h, r);
    cctx.arcTo(x, y + h, x, y, r); cctx.arcTo(x, y, x + w, y, r); cctx.closePath();
}

function wrapText(cctx, text, maxW) {
    const words = String(text).split(/\s+/); const lines = []; let line = '';
    for (const wd of words) {
        const test = line ? line + ' ' + wd : wd;
        if (cctx.measureText(test).width > maxW && line) { lines.push(line); line = wd; }
        else line = test;
    }
    if (line) lines.push(line);
    return lines.slice(0, 4); // maks 4 baris (kanvas portrait)
}

function sanitizeFile(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'naskah';
}
