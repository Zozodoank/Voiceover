// public/js/studio.js - Upload video, generator VO & timeline adegan
// Pratinjau & pemutaran suara memakai TTS via previewVoice()/getSelectedVoice() (voices.js).

// Info di bawah judul hanya menampilkan Kualitas (tanpa membocorkan model/engine ke pengguna).
function qualityLabelForSelectedModel() {
    const r = document.querySelector('input[name="ttsModel"]:checked');
    if (!r) return '';
    const el = r.parentElement.querySelector('.text-xs.font-bold');
    return (el ? el.innerText : '').trim();
}
function refreshActiveModelStatusLabel() {
    const el = document.getElementById('activeModelStatusLabel');
    if (!el) return;
    const q = qualityLabelForSelectedModel();
    if (q) el.innerText = `Kualitas: ${q} • Emosi Per Adegan`;
}
(function wireModelQualityLabel() {
    document.querySelectorAll('input[name="ttsModel"]').forEach((inp) => inp.addEventListener('change', refreshActiveModelStatusLabel));
    refreshActiveModelStatusLabel();
})();

async function initiateCommercialGeneration() {
    const productName = document.getElementById('productNameInput').value.trim();
    if (!productName) {
        showToast('Mohon masukkan nama produk terlebih dahulu!', 'error');
        document.getElementById('productNameInput').focus();
        return;
    }

    const selectedModelRadio = document.querySelector('input[name="ttsModel"]:checked');
    const modelValue = selectedModelRadio.value;
    const modelPrice = parseInt(selectedModelRadio.getAttribute('data-price'), 10);
    const modelName = selectedModelRadio.parentElement.querySelector('.text-xs.font-bold').innerText;
    const selectedVoice = getSelectedVoice();
    const gender = selectedVoice.gender;
    const voiceName = selectedVoice.name;
    const platform = (document.querySelector('input[name="ctaPlatform"]:checked') || {}).value || 'shopee';

    // Gerbang saldo hanya cermin UI - Worker tetap memvalidasi & mendebit dari D1
    if (!userUnlimited && userBalance < modelPrice) {
        showToast(`Saldo Anda tidak cukup (Rp ${userBalance.toLocaleString('id-ID')}). Harap Top Up QRIS minimal Rp ${modelPrice.toLocaleString('id-ID')}.`, 'error');
        openTopUpQrisModal(modelPrice);
        return;
    }

    const statusBox = document.getElementById('generationStatusBox');
    const statusText = document.getElementById('generationStatusText');
    const progressBar = document.getElementById('generationProgressBar');
    const percentLabel = document.getElementById('generationPercent');
    statusBox.classList.remove('hidden');

    const setProgress = (pct, html) => {
        progressBar.style.width = pct + '%';
        percentLabel.innerText = pct + '%';
        statusText.innerHTML = html;
    };

    // Tahap 1: ekstrak frame di browser (hemat kuota; video utuh tidak pernah dikirim)
    setProgress(20, `<i class="fa-solid fa-circle-notch fa-spin"></i> Mengekstrak frame video di perangkat Anda...`);
    let frameDataUrls;
    let frameTimes;
    const duration = getVideoDurationS() || 15; // durasi video = jam visual yang dipakai AI
    try {
        if (uploadedVideoFile) {
            const frames = await extractFrames(uploadedVideoFile, { fps: 1, maxFrames: 6, width: 320, quality: 0.65 });
            frameDataUrls = frames.map(f => f.dataUrl);
            // Detik tiap frame WAJIB ikut ke server: tanpa ini AI mengira 1 frame = 1 detik.
            frameTimes = frames.map(f => Math.round(f.t * 100) / 100);
        } else {
            throw new Error('Belum ada video dimuat. Upload video produk terlebih dahulu.');
        }
    } catch (err) {
        statusBox.classList.add('hidden');
        showToast('Gagal mengekstrak frame: ' + err.message, 'error');
        return;
    }

    // Tahap 2: analisa AI di Worker (Gemini utama, fallback AIVene qwen3.8-flash)
    setProgress(55, `<i class="fa-solid fa-circle-notch fa-spin"></i> AI menganalisa ${frameDataUrls.length} frame & menyusun naskah emosi...`);
    let resp;
    try {
        resp = await apiFetch('/api/analyze', {
            method: 'POST',
            body: {
                frames: frameDataUrls,
                frameTimes,
                productName,
                affiliateLink: document.getElementById('affiliateLinkInput').value.trim(),
                duration,
                gender,
                voiceName,
                platform,
                modelValue
            }
        });
    } catch (err) {
        statusBox.classList.add('hidden');
        if (err.handled) return;
        if (err.status === 402) {
            const d = err.data || {};
            showToast(`Saldo tidak cukup di server (Rp ${(d.have || 0).toLocaleString('id-ID')}). Top up QRIS dulu ya.`, 'error');
            openTopUpQrisModal(modelPrice);
        } else if (err.status === 502) {
            showToast('Server AI gagal memproses (Gemini & AIVene). Coba lagi sebentar.', 'error');
        } else {
            showToast('Analisa gagal: ' + err.message, 'error');
        }
        return;
    }

    setProgress(90, `<i class="fa-solid fa-circle-notch fa-spin"></i> Menyusun timeline adegan...`);
    const r = resp.result;
    const resolvedModelLabel = resp.modelLabel || modelName; // label dari server (otoritatif)
    const affLink = document.getElementById('affiliateLinkInput').value;

    if (!userUnlimited && resp.balance != null) userBalance = Number(resp.balance) || 0;
    refreshBalanceBadge();

    // Menerapkan Pola Emosi Berbeda di Setiap Adegan (Per Kalimat Voice Over)
    generatedScenesData = r.scenes;
    const platformCtaText = { shopee: 'cek keranjang orange sekarang', tiktok: 'cek keranjang kuning di bawah', reels: 'klik link di bio', youtube: 'subscribe & cek link di deskripsi' }[platform] || 'cek keranjang sekarang';
    generatedCaptionText = r.caption || `Wajib punya! ${productName} — ${platformCtaText}! ✨`;
    generatedHashtagsText = r.hashtags || `#RacunShopee #${productName.replace(/\s+/g, '')} #FYP #SkincareIndonesia`;

    document.getElementById('captionOutput').value = generatedCaptionText;
    document.getElementById('hashtagsOutput').innerText = generatedHashtagsText;
    document.getElementById('affiliateCardTitle').innerText = productName;
    document.getElementById('affiliateLinkDisplay').innerText = affLink;

    renderScenesTimeline(generatedScenesData);
    document.getElementById('sceneCountBadge').innerText = generatedScenesData.length + ' Segmen';

    document.getElementById('playMergedBtn').removeAttribute('disabled');
    document.getElementById('exportMergedBtn').removeAttribute('disabled');
    document.getElementById('activeModelStatusLabel').innerText = `Kualitas: ${resolvedModelLabel} • Emosi Per Adegan`;

    const newRecord = {
        productName,
        affiliateLink: affLink,
        modelLabel: resolvedModelLabel,
        gender,
        voiceName,
        videoDuration: duration,
        caption: generatedCaptionText,
        hashtags: generatedHashtagsText,
        scenesCount: generatedScenesData.length,
        scenes: generatedScenesData,
        timestamp: new Date().toLocaleString('id-ID')
    };
    saveRecordToHistory(newRecord);

    setProgress(100, `<i class="fa-solid fa-circle-check text-emerald-400"></i> Voice Over Berpola Emosi & Subtitle Selesai!`);
    showToast('Voice Over berpola emosi berhasil dibuat dan disimpan ke Riwayat!', 'success');
    setTimeout(() => statusBox.classList.add('hidden'), 3000);

    // Prerender audio Gemini TTS untuk semua adegan di latar belakang (agar Putar/Unduh WebM langsung sinkron).
    if (typeof invalidateSceneAudios === 'function') invalidateSceneAudios();
    if (typeof ensureSceneAudios === 'function') {
        showToast('Menyiapkan audio tiap adegan…', 'info');
        ensureSceneAudios().then(() => {
            paintSceneDurations();
        }).catch(() => { /* audio diulang lagi saat Putar/Unduh ditekan */ });
    }
}

/** Escape teks dari AI sebelum masuk ke innerHTML: cegah HTML/JS injection & tanda kutip yang merusak markup. */
function esc(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderScenesTimeline(scenes) {
    const container = document.getElementById('scenesContainer');
    // Delegasi klik dipasang sekali: teks adegan berasal dari AI, jadi tidak boleh jadi atribut inline.
    if (!container.dataset.sceneClickBound) {
        container.dataset.sceneClickBound = '1';
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-scene-play]');
            if (!btn) return;
            const idx = Number(btn.getAttribute('data-scene-play'));
            const scene = (generatedScenesData || [])[idx];
            if (scene) playSceneAudio(scene, idx);
        });
    }
    container.innerHTML = scenes.map((s, idx) => `
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
            <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <span class="w-5 h-5 rounded-full bg-brand-500/20 text-brand-400 font-bold text-[11px] flex items-center justify-center shrink-0">${idx + 1}</span>
                    <span class="text-[11px] font-bold text-amber-300 px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded-md">${esc(s.emotion)}</span>
                </div>
                <span class="text-[10px] text-slate-400 font-mono" data-scene-time="${idx}">${esc(s.start)}s - ${esc(s.end)}s</span>
            </div>
            <div class="flex items-center justify-between gap-2">
                <p class="text-xs font-semibold text-slate-200 truncate flex-1">${esc(s.text)}</p>
                <button data-scene-play="${idx}" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs shrink-0 flex items-center gap-1">
                    <i class="fa-solid fa-volume-high text-brand-400"></i> Dengar
                </button>
            </div>
        </div>
    `).join('');
}

function playSceneAudio(scene, idx) {
    // Dengarkan naskah adegan dengan voice TTS terpilih + nuansa emosi (model mengikuti tier kualitas).
    // Audio hasil prerender dipakai lebih dulu: tempo sudah disesuaikan & tidak memakan kuota TTS.
    if (typeof playCachedSceneAudio === 'function' && playCachedSceneAudio(Number(idx))) return;
    const v = getSelectedVoice();
    const tier = (typeof getSelectedTier === 'function') ? getSelectedTier() : '';
    previewVoice(v.name, null, scene.text, scene.emotion, tier);
}

/** Tempelkan waktu adegan dari timeline (jendela visual + durasi audio asli, bukan tebakan AI). */
function paintSceneDurations() {
    if (typeof buildTimeline !== 'function') return;
    const tl = (typeof window.getSceneTimeline === 'function') ? window.getSceneTimeline() : buildTimeline();
    tl.segments.forEach((seg) => {
        const el = document.querySelector('[data-scene-time="' + seg.index + '"]');
        if (el) el.innerText = seg.start.toFixed(1) + 's - ' + seg.end.toFixed(1) + 's';
    });
    if (typeof paintPlaybackClock === 'function') paintPlaybackClock(0, tl.total);
}
