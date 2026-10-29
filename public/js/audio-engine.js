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

// Subtitle burn-in: satu tempat untuk ukuran, warna, dan ritme kemunculan.
const SUB_FONT_PX = 46;             // sebelumnya 60 ("kecilkan sedikit")
const SUB_LINE_H = 58;              // sebelumnya 74
const SUB_MAX_LINES = 2;            // cue 3 kata -> hampir selalu 1 baris
const SUB_WORDS_PER_CUE = 3;        // kata per kemunculan, mengikuti voice over
const SUB_MAX_WIDTH = EXPORT_W - 160;
const SUB_BOTTOM_PAD = 150;         // jarak baseline baris terakhir dari bawah kanvas
const SUB_COLOR_IDLE = '#ffffff';   // kata lain di cue
const SUB_COLOR_ACTIVE = '#fde047'; // kata yang sedang diucapkan
const SUB_STROKE_PX = 5;            // garis tepi (bukan kotak latar): 8 terlalu tebal, 3 tenggelam di footage terang
const SUB_PAUSE_WEIGHT = 3;         // kata berakhir tanda baca -> diucapkan lebih lama

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
        const start = cursor, end = cursor + dur;
        segments.push({
            index: i,
            start,
            end,
            dur,
            text: scenes[i].text || '',
            emotion: scenes[i].emotion || '',
            cues: buildSubtitleCues(scenes[i].text, start, end), // dipakai burn-in & overlay pratinjau
        });
        cursor = end + SCENE_GAP_S;
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
    // Dua pembacaan di titik waktu yang sama: jam audio (acuan penjadwalan) dan jam dinding.
    // Dipakai createRunClock() agar visual tetap berjalan walau jam audio berhenti.
    const scheduledAt = ctx.currentTime;
    const scheduledWall = performance.now();
    const startTime = scheduledAt + (Number.isFinite(leadIn) && leadIn >= 0 ? leadIn : 0.08);
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
        scheduledAt,
        scheduledWall,
        timeline,
        stop: () => { _activeSources.forEach(s => { try { s.stop && s.stop(); } catch (e) { /* ignore */ } }); },
    };
}

/**
 * Jam detik berjalan untuk menggambar frame (playback maupun ekspor).
 * Audio dijadwalkan di atas jam AudioContext, tetapi jam itu bisa BERHENTI walau dinding terus
 * berjalan - misalnya browser tanpa perangkat audio (headless), tab di latar, atau device yang
 * diambil alih aplikasi lain. Dulu visual ikut membeku di satu frame subtitle. Sekarang jam
 * dinding yang dijangkarkan ke jadwal audio diambil sebagai batas atas: frame tidak pernah
 * tertinggal dari suara, dan tidak pernah diam menunggu jam yang berhenti.
 */
function createRunClock(ctx, run) {
    const leadS = run.startTime - run.scheduledAt; // jarak jadwal -> awal audio (lead-in)
    let last = 0;
    return function elapsedSeconds() {
        const audio = ctx.currentTime - run.startTime;
        const wall = (performance.now() - run.scheduledWall) / 1000 - leadS;
        const next = Math.max(audio, wall, 0);
        if (next > last) last = next; // monoton: jam audio yang melompat mundur tidak memutar balik video
        return last;
    };
}

/** Perbarui overlay pratinjau (cue yang sama dengan burn-in) + badge adegan. */
function updateOverlayDOM(sceneIdx, sub) {
    const scene = (generatedScenesData || [])[sceneIdx] || {};
    const badge = document.getElementById('currentSceneBadgeText');
    if (badge && sceneIdx >= 0) badge.innerText = `Adegan ${sceneIdx + 1}: ${scene.emotion || ''}`;
    renderOverlaySubtitle(sub);
}

/** Tulis cue aktif ke overlay pratinjau: warna & kata sama dengan burn-in kanvas. */
function renderOverlaySubtitle(sub) {
    const el = document.getElementById('subtitleOverlayText');
    if (!el) return;
    el.textContent = '';
    if (!sub || !sub.cue) return;
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
    const clock = createRunClock(ctx, run);
    // Tulis DOM hanya saat state subtitle berubah (per kata), bukan tiap frame.
    let lastKey = '';
    (function loop() {
        if (_playToken !== myTok) return;
        const elapsed = clock();
        if (elapsed >= run.timeline.total) { stopEverything(); resetPlayBtn && resetPlayBtn(); return; }
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
        // requestFrame() dipakai bila tersedia: stream dibuat beralaju 0 dan satu frame diminta tepat
        // setelah kanvas selesai digambar, jadi isi rekaman SELALU frame terbaru. Timer kompositor
        // tidak lagi menentukan isi frame - di sebagian lingkungan (browser headless, tab tersembunyi)
        // timer itu berhenti sehingga rekaman membeku di satu gambar. Tanpa requestFrame() jatuh ke
        // laju tetap seperti sebelumnya.
        let stream = comp.captureStream(0);
        let vTrack = stream.getVideoTracks()[0];
        const manualFrames = !!(vTrack && typeof vTrack.requestFrame === 'function');
        if (!manualFrames) {
            stream.getVideoTracks().forEach(t => { try { t.stop(); } catch (e) { /* ignore */ } });
            stream = comp.captureStream(EXPORT_FPS);
            vTrack = stream.getVideoTracks()[0];
        }
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
        let watchdog = 0;
        const finish = () => {
            if (stopped) return; stopped = true;
            if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
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
        const clock = createRunClock(ctx, run);
        // Jaring pengaman: bila requestAnimationFrame berhenti total (tab benar-benar tersembunyi),
        // ekspor tetap ditutup supaya tombol Unduh tidak terkunci selamanya.
        watchdog = setTimeout(finish, (LEAD_IN_S + run.timeline.total + 5) * 1000);
        // Sumber senyap (gain 0) menjaga track audio MediaStreamDestination tetap merender selama
        // rekaman. Tanpa ini, saat tidak ada buffer audio, Chrome menulis WebM 0-byte.
        const kaGain = ctx.createGain(); kaGain.gain.value = 0;
        kaOsc = ctx.createOscillator(); kaOsc.type = 'sine'; kaOsc.frequency.value = 1;
        kaOsc.connect(kaGain); kaGain.connect(dest);
        kaOsc.start(run.startTime); kaOsc.stop(run.startTime + run.timeline.total + 0.5);

        const frameMs = 1000 / EXPORT_FPS;
        let lastFrameAt = 0;
        (function draw() {
            if (_playToken !== myTok) { finish(); return; }
            const elapsed = clock();
            if (elapsed >= run.timeline.total) { setTimeout(finish, 250); return; }
            // Paling banyak satu frame per EXPORT_FPS. Menggambar lebih cepat dari laju rekaman hanya
            // membuat encoder membuang frame (encoder software bisa tertinggal jauh), sehingga isi
            // video jadi lebih sedikit daripada yang digambar.
            const now = performance.now();
            if (now - lastFrameAt < frameMs - 1) { _rafId = requestAnimationFrame(draw); return; }
            lastFrameAt = now;
            const segIdx = subtitleIndexAt(run.timeline.segments, Math.max(0, elapsed));
            const seg = segIdx >= 0 ? run.timeline.segments[segIdx] : null;
            const sceneIdx = segIdx >= 0 ? run.timeline.segments[segIdx].index : (run.timeline.segments[0] || {}).index || 0;
            const t = Math.max(0, elapsed);
            const cue = seg ? subtitleCueAt(seg.cues, t) : null;
            const sub = seg ? { cue, word: activeSubtitleWord(cue, t) } : null;
            try {
                drawFrame(cctx, comp, sceneIdx, sub);
            } catch (err) {
                if (err && err.name === 'SecurityError') { finish(); showToast('Video lintas-origin menodai kanvas (CORS). Ekspor dibatalkan; pakai .SRT.', 'error'); return; }
            }
            if (manualFrames) { try { vTrack.requestFrame(); } catch (e) { /* ignore */ } }
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

/**
 * Pecah teks adegan jadi cue pendek (SUB_WORDS_PER_CUE kata) + waktu tiap kata.
 * TTS tidak mengirim timestamp per kata, jadi durasi dibagi proporsional dari panjang
 * kata + jeda tanda baca, DI DALAM durasi audio asli adegan. Cue selalu bersambung
 * (cue.end === cue berikutnya.start) sehingga tidak ada kedip di tengah adegan.
 * -> [{ start, end, words: [{ text, start, end }] }]
 */
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

/** Cue yang tampil pada detik t (null saat jeda antar adegan / belum bicara). */
function subtitleCueAt(cues, t) {
    const list = cues || [];
    for (let i = 0; i < list.length; i++) {
        if (t >= list[i].start && t < list[i].end) return list[i];
    }
    return null;
}

/** Kata yang sedang diucapkan di dalam cue (null bila cue kosong). */
function activeSubtitleWord(cue, t) {
    if (!cue) return null;
    let cur = cue.words[0] || null;
    for (const w of cue.words) { if (t >= w.start) cur = w; else break; }
    return cur;
}

/** Gambar satu frame kompositor: visual (video/kanvas) + badge emosi + subtitle burn-in. */
function drawFrame(cctx, comp, idx, sub) {
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
    drawSubtitle(cctx, comp, sub);
}

/**
 * Burn-in subtitle: cue pendek di bawah tengah, tanpa kotak latar.
 * Kata yang sedang diucapkan kuning, kata lain putih (gaya "viral").
 */
function drawSubtitle(cctx, comp, sub) {
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

/** Bungkus kata cue jadi baris (maks SUB_MAX_LINES) dari lebar tiap kata. */
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
