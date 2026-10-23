// public/js/audio-engine.js - Mesin audio Gemini TTS: prerender per adegan, playback tersinkron durasi
// asli, dan ekspor video WebM nyata (kanvas kompositor + MediaRecorder + audio mix + burn subtitle).
// Classic script: memakai global (generatedScenesData, sceneAudios, getSelectedVoice,
// getVisualSource, showToast, apiFetch).

let _audioCtx = null;
let _playToken = 0;          // pembatalan playback aktif (klik Putar/Jeda/Rekam saat diputar)
let _activeSources = [];     // AudioBufferSourceNode aktif agar bisa dihentikan
let _rafId = 0;
let _prerenderInflight = null; // promise prerender aktif (hindari panggilan ganda)

const EXPORT_W = 720, EXPORT_H = 405, EXPORT_FPS = 30;

function audioCtx() {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    return _audioCtx;
}

/** Signature voice + isi naskah (deteksi perlu prerender ulang tidak). */
function sceneAudioSignature() {
    const v = (typeof getSelectedVoice === 'function') ? getSelectedVoice().name : '';
    return v + '||' + (generatedScenesData || []).map(s => (s.emotion || '') + '#' + (s.text || '')).join('||');
}

/** Estimasi durasi (detik) bila audio adegan gagal dibuat. */
function fallbackDuration(scene) {
    if (scene && scene.end > scene.start) return Math.max(1.5, Number(scene.end) - Number(scene.start));
    const words = String((scene && scene.text) || '').split(/\s+/).filter(Boolean).length;
    return Math.max(1.5, words / 2.4);
}

/** Ambil satu cuplikan TTS sebagai AudioBuffer (plus blobUrl). Melempar error bila gagal. */
async function fetchPreviewBuffer(voiceName, text, emotion) {
    const res = await fetch('/api/tts/preview', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceName, text, emotion: emotion || undefined }),
    });
    const ct = res.headers.get('Content-Type') || '';
    if (!res.ok || ct.indexOf('audio') === -1) throw new Error('tts_' + res.status);
    const blob = await res.blob();
    const buf = await audioCtx().decodeAudioData(await blob.arrayBuffer());
    return { buffer: buf, duration: buf.duration, blobUrl: URL.createObjectURL(blob) };
}

/** Buat audio untuk SEMUA adegan (paralel terbatas 3). Slot gagal -> null (dipakai saat putar/ekspor). */
async function prerenderSceneAudios() {
    const scenes = generatedScenesData || [];
    const vName = (typeof getSelectedVoice === 'function') ? getSelectedVoice().name : 'alloy';
    const sig = sceneAudioSignature();
    sceneAudios = new Array(scenes.length).fill(null);
    sceneAudiosKey = ''; // tandai belum siap sampai selesai

    let done = 0, fail = 0;
    const queue = scenes.map((s, i) => ({ s, i }));
    const workers = [];
    const CONC = 3;
    async function worker() {
        while (queue.length) {
            const { s, i } = queue.shift();
            try {
                sceneAudios[i] = await fetchPreviewBuffer(vName, s.text, s.emotion);
            } catch (e) {
                sceneAudios[i] = null; fail++;
            }
            done++;
        }
    }
    for (let k = 0; k < Math.min(CONC, scenes.length); k++) workers.push(worker());
    await Promise.all(workers);
    sceneAudiosKey = sig; // sukses (meski sebagian null) -> jangan prerender ulang
    return { ok: scenes.length - fail, fail };
}

/** Pastikan sceneAudios cocok dengan naskah/voice terpilih; prerender bila perlu (tunggu in-flight). */
async function ensureSceneAudios() {
    if (_prerenderInflight) { await _prerenderInflight; return; }
    const sig = sceneAudioSignature();
    if (sceneAudiosKey === sig && sceneAudios.length === (generatedScenesData || []).length && sceneAudios.length > 0) return;
    _prerenderInflight = prerenderSceneAudios().then((r) => { _prerenderInflight = null; return r; })
        .catch((e) => { _prerenderInflight = null; throw e; });
    await _prerenderInflight;
}

/** Hitung jadwal kumulatif dari durasi audio (bukan timestamp teks) untuk sinkron riil. */
function computeSchedule() {
    const scenes = generatedScenesData || [];
    let t = 0; const slots = [];
    for (let i = 0; i < scenes.length; i++) {
        const a = sceneAudios[i];
        const dur = a ? a.duration : fallbackDuration(scenes[i]);
        slots.push({ start: t, dur });
        t += dur;
    }
    return { slots, total: t };
}

function activeIndexAt(slots, elapsed) {
    for (let i = 0; i < slots.length; i++) {
        if (elapsed < slots[i].start + slots[i].dur) return i;
    }
    return slots.length - 1;
}

/** Jadwalkan seluruh adegan berurutan pada ctx. kembalikan { startTime, stop }. */
function scheduleScenes(ctx, destNodes) {
    const slots = computeSchedule();
    const startTime = ctx.currentTime + 0.08;
    _activeSources = [];
    (generatedScenesData || []).forEach((scene, i) => {
        const a = sceneAudios[i];
        if (a && a.buffer) {
            const src = ctx.createBufferSource();
            src.buffer = a.buffer;
            destNodes.forEach(d => src.connect(d));
            src.start(startTime + slots.slots[i].start);
            _activeSources.push(src);
        } else if (window.speechSynthesis) {
            // Fallback tanpa buffer: ucapkan via speechSynthesis pada waktu scene (paling dekat).
            const delay = Math.max(0, (slots.slots[i].start) * 1000);
            const to = setTimeout(() => {
                if (_playToken === ctx._tok) {
                    const u = new SpeechSynthesisUtterance(scene.text); u.lang = 'id-ID'; speechSynthesis.speak(u);
                }
            }, delay);
            _activeSources.push({ stop: () => clearTimeout(to) });
        }
    });
    return { startTime, slots, stop: () => { _activeSources.forEach(s => { try { s.stop && s.stop(); } catch (e) { /* ignore */ } }); } };
}

function updateOverlayDOM(idx) {
    const scene = (generatedScenesData || [])[idx] || {};
    const sub = document.getElementById('subtitleOverlayText');
    const badge = document.getElementById('currentSceneBadgeText');
    if (sub) sub.innerText = scene.text || '';
    if (badge) badge.innerText = `Adegan ${idx + 1}: ${scene.emotion || ''}`;
}

function stopEverything() {
    _playToken++;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
    _activeSources.forEach(s => { try { s.stop && s.stop(); } catch (e) { /* ignore */ } });
    _activeSources = [];
    if (window.speechSynthesis) speechSynthesis.cancel();
    const v = document.getElementById('mainVideo');
    if (v && !v.paused) { try { v.pause(); } catch (e) { /* ignore */ } }
    ['subtitleOverlayContainer', 'sceneOverlayBadge'].forEach(id => {
        const el = document.getElementById(id); if (el) el.classList.add('hidden');
    });
}

/** Mulai playback gabungan tersinkron audio asli (sumber visual: video/kanvas). */
async function startMergedPlayback() {
    await ensureSceneAudios();
    if (!generatedScenesData || !generatedScenesData.length) return;
    stopEverything();
    const myTok = ++_playToken;
    const ctx = audioCtx(); ctx._tok = myTok;

    // Siapkan visual
    const src = getVisualSource();
    if (src.type === 'video') { try { src.el.currentTime = 0; src.el.muted = true; src.el.loop = true; await src.el.play(); } catch (e) { /* autoplay */ } }
    document.getElementById('subtitleOverlayContainer').classList.remove('hidden');
    document.getElementById('sceneOverlayBadge').classList.remove('hidden');

    const run = scheduleScenes(ctx, [ctx.destination]);
    let lastIdx = -1;
    (function loop() {
        if (_playToken !== myTok) return;
        const elapsed = ctx.currentTime - run.startTime;
        if (elapsed >= run.slots.total) { stopEverything(); resetPlayBtn && resetPlayBtn(); return; }
        const idx = activeIndexAt(run.slots.slots, elapsed);
        if (idx !== lastIdx) { updateOverlayDOM(idx); lastIdx = idx; }
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
    if (btn && btn.disabled) return; // cegah klik ganda
    if (!window.MediaRecorder) { showToast('Browser tidak mendukung MediaRecorder. Pakai unduh .SRT.', 'error'); return; }
    if (!navigator.mediaDevices || !HTMLCanvasElement.prototype.captureStream) {
        showToast('Ekspor video tidak didukung di browser ini. Pakai unduh .SRT.', 'error'); return;
    }

    if (btn) btn.disabled = true;
    stopEverything();
    try {
        await ensureSceneAudios();
        if (!generatedScenesData || !generatedScenesData.length) throw new Error('Belum ada naskah.');

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
        const name = sanitizeFile((document.getElementById('productNameInput') || {}).value || 'naskah');
        let stopped = false;
        const finish = () => {
            if (stopped) return; stopped = true;
            if (_rafId) cancelAnimationFrame(_rafId);
            run.stop();
            try { kaOsc.stop(); } catch (e) { /* ignore */ }
            try { recorder.stop(); } catch (e) { /* ignore */ }
            stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* ignore */ } });
        };

        // Mulai visual video (muted; audio dari TTS)
        const vis = getVisualSource();
        if (vis.type === 'video') { try { vis.el.currentTime = 0; vis.el.muted = true; vis.el.loop = true; await vis.el.play(); } catch (e) { /* ignore */ } }

        const run = scheduleScenes(ctx, [dest]); // audio TTS -> stream
        // Sumber senyap (gain 0) menjaga track audio MediaStreamDestination tetap merender selama
        // rekaman. Tanpa ini, saat tidak ada buffer audio (mis. kuota Gemini 429) Chrome menulis WebM 0-byte.
        const kaGain = ctx.createGain(); kaGain.gain.value = 0;
        const kaOsc = ctx.createOscillator(); kaOsc.type = 'sine'; kaOsc.frequency.value = 1;
        kaOsc.connect(kaGain); kaGain.connect(dest);
        kaOsc.start(run.startTime); kaOsc.stop(run.startTime + run.slots.total + 0.5);
        recorder.start(200);

        const t0 = performance.now();
        (function draw() {
            if (_playToken !== myTok) { finish(); return; }
            const elapsed = ctx.currentTime - run.startTime;
            if (elapsed >= run.slots.total) { setTimeout(finish, 250); return; }
            const idx = activeIndexAt(run.slots.slots, Math.max(0, elapsed));
            try {
                drawFrame(cctx, comp, idx);
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
        const a = document.createElement('a'); a.href = url; a.download = `VO_${name}_${Date.now()}.webm`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        showToast('Video WebM (VO + subtitle) berhasil diunduh!', 'success');
    } catch (e) {
        showToast('Ekspor gagal: ' + (e.message || e) + '. Coba unduh .SRT.', 'error');
    } finally {
        resetPlayBtn();
        if (btn) btn.disabled = false;
    }
}

function pickWebmMime() {
    const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm'];
    for (const m of cands) { if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m; }
    return '';
}

/** Gambar satu frame kompositor: visual (video/kanvas) + badge emosi + subtitle burn-in. */
function drawFrame(cctx, comp, idx) {
    const scene = (generatedScenesData || [])[idx] || {};
    const vis = getVisualSource();
    // dasar hitam
    cctx.fillStyle = '#000'; cctx.fillRect(0, 0, comp.width, comp.height);
    if (vis.type === 'video' && vis.el && vis.el.readyState >= 2) {
        drawContain(cctx, vis.el, comp.width, comp.height);
    }
    // badge adegan (kiri atas)
    cctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(cctx, 12, 12, 240, 30, 15); cctx.fill();
    cctx.fillStyle = '#fff'; cctx.font = 'bold 15px Inter, sans-serif'; cctx.textAlign = 'left'; cctx.textBaseline = 'middle';
    cctx.fillText(`Adegan ${idx + 1}: ${scene.emotion || ''}`, 24, 27);
    // subtitle burn-in (bawah, tengah)
    const text = scene.text || '';
    if (text) {
        cctx.font = '800 26px Inter, sans-serif'; cctx.textAlign = 'center'; cctx.textBaseline = 'alphabetic';
        const lines = wrapText(cctx, text, comp.width - 60);
        let y = comp.height - 40 - (lines.length - 1) * 34;
        for (const ln of lines) {
            cctx.lineWidth = 5; cctx.strokeStyle = 'rgba(0,0,0,0.85)'; cctx.strokeText(ln, comp.width / 2, y);
            cctx.fillStyle = '#fde047'; cctx.fillText(ln, comp.width / 2, y);
            y += 34;
        }
    }
}

/** Gambar sumber video menjaga rasio aspek di dalam w×h, ter-center. */
function drawContain(cctx, el, w, h) {
    const sw = el.videoWidth || el.width || w, sh = el.videoHeight || el.height || h;
    const scale = Math.min(w / sw, h / sh);
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
    return lines.slice(0, 3); // maks 3 baris
}

function sanitizeFile(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'naskah';
}
