// public/js/video.js - Pipeline sumber video: upload file -> elemen #mainVideo (untuk playback & ekspor WebM).
// Classic script: menjalankan wiring saat dimuat (skrip berada di akhir <body>, jadi DOM sudah tersedia).

let _videoObjectUrl = null; // object URL aktif agar bisa revoke saat ganti file (hindari leak)

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

    mainVideo.onloadedmetadata = () => {
        const dur = Number(mainVideo.duration) || 0;
        document.getElementById('videoDurationBadge').innerText = dur.toFixed(1) + 's';
        const segs = Math.max(2, Math.min(6, Math.round(dur / 5)));
        document.getElementById('sceneCountBadge').innerText = segs + ' Segmen';
    };
    mainVideo.onerror = () => showToast('Gagal memuat video. Coba file lain.', 'error');

    // Audio hasil prerender lama tidak relevan dengan video baru
    sceneAudios = [];
    sceneAudiosKey = '';
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
