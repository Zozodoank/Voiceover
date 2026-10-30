// public/js/video.js - Pipeline sumber video: upload file -> elemen #mainVideo (untuk playback & ekspor WebM).
// Classic script: menjalankan wiring saat dimuat (skrip berada di akhir <body>, jadi DOM sudah tersedia).

// Klaim di UI ("Maks 30 Detik") ditegakkan di sini: video lebih panjang membuat anggaran kata per
// adegan tidak realistis dan seek video saat ekspor makin berat di perangkat lambat.
const MAX_VIDEO_DURATION_S = 30;

let _videoObjectUrl = null; // object URL aktif agar bisa revoke saat ganti file (hindari leak)

/** Kembalikan UI ke keadaan "belum ada video" setelah file ditolak. */
function resetVideoUi(message) {
    const mainVideo = document.getElementById('mainVideo');
    if (mainVideo) {
        try { mainVideo.pause(); } catch (e) { /* ignore */ }
        mainVideo.removeAttribute('src');
        try { mainVideo.load(); } catch (e) { /* ignore */ }
        mainVideo.classList.add('hidden');
    }
    if (_videoObjectUrl) { try { URL.revokeObjectURL(_videoObjectUrl); } catch (e) { /* ignore */ } }
    _videoObjectUrl = null;
    uploadedVideoFile = null;
    // Batalkan audio prerender (termasuk yang sedang berjalan) - timeline video sudah tidak ada.
    if (typeof invalidateSceneAudios === 'function') invalidateSceneAudios();
    ['uploadPrompt', 'videoEmptyOverlay'].forEach((id) => {
        const el = document.getElementById(id); if (el) el.classList.remove('hidden');
    });
    const ok = document.getElementById('uploadSuccess');
    if (ok) ok.classList.add('hidden');
    ['subtitleOverlayContainer', 'sceneOverlayBadge'].forEach((id) => {
        const el = document.getElementById(id); if (el) el.classList.add('hidden');
    });
    if (message) showToast(message, 'error');
}

/** Validasi & muat file video ke #mainVideo + perbarui badge UI. */
function handleVideoFile(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    if (!/^video\//.test(file.type || '')) {
        showToast('File harus berupa video (MP4, WebM, MOV).', 'error');
        return;
    }

    uploadedVideoFile = file;
    videoSourceIsRemote = false;

    const mainVideo = document.getElementById('mainVideo');
    if (_videoObjectUrl) { try { URL.revokeObjectURL(_videoObjectUrl); } catch (e) { /* ignore */ } }
    _videoObjectUrl = URL.createObjectURL(file);
    mainVideo.crossOrigin = 'anonymous';
    mainVideo.src = _videoObjectUrl;
    mainVideo.muted = false;
    mainVideo.loop = false;

    // Tampilkan video & sembunyikan overlay kosong
    mainVideo.classList.remove('hidden');
    document.getElementById('videoEmptyOverlay').classList.add('hidden');
    document.getElementById('uploadPrompt').classList.add('hidden');
    document.getElementById('uploadSuccess').classList.remove('hidden');
    document.getElementById('fileNameDisplay').innerText = file.name;
    ['subtitleOverlayContainer', 'sceneOverlayBadge'].forEach((id) => {
        const el = document.getElementById(id); if (el) el.classList.add('hidden');
    });

    mainVideo.onloadedmetadata = () => {
        const dur = Number(mainVideo.duration) || 0;
        if (dur > MAX_VIDEO_DURATION_S + 0.05) {
            resetVideoUi(`Durasi video ${dur.toFixed(1)}s melebihi batas ${MAX_VIDEO_DURATION_S} detik. Pilih video yang lebih pendek.`);
            return;
        }
        document.getElementById('videoDurationBadge').innerText = dur.toFixed(1) + 's';
        // Jumlah adegan nyata baru diketahui setelah generate -> jangan tampilkan tebakan.
        document.getElementById('sceneCountBadge').innerText = '—';
    };
    mainVideo.onerror = () => showToast('Gagal memuat video. Coba file lain.', 'error');

    // Audio hasil prerender lama tidak relevan dengan video baru (timeline berubah -> prerender ulang)
    if (typeof invalidateSceneAudios === 'function') invalidateSceneAudios();
    showToast('Video dimuat: ' + file.name, 'success');
}

/** Sumber visual aktif untuk playback/ekspor: selalu elemen video unggahan. */
function getVisualSource() {
    return { type: 'video', el: document.getElementById('mainVideo') };
}

// Wiring: #videoInput (input file di dropzone) -> handleVideoFile.
(function wireVideoInput() {
    const input = document.getElementById('videoInput');
    if (input) input.addEventListener('change', (e) => handleVideoFile(e.target));
})();
