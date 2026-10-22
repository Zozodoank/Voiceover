// public/js/frames.js - Ekstraksi frame video di SISI BROWSER (hemat kuota & aman untuk limit
// request API AI): sample 1 FPS, turunke JPEG <=768px, maks 16 frame. Tanpa ffmpeg.

function _waitVideoEvent(video, event, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Waktu tunggu video habis')); }, timeoutMs || 10000);
        function onOk() { cleanup(); resolve(); }
        function onErr() { cleanup(); reject(new Error('Video tidak dapat diputar browser')); }
        function cleanup() {
            clearTimeout(timer);
            video.removeEventListener(event, onOk);
            video.removeEventListener('error', onErr);
        }
        video.addEventListener(event, onOk, { once: true });
        video.addEventListener('error', onErr, { once: true });
    });
}

/**
 * Ambil cuplikan frame dari file/URL video.
 * @returns Promise<Array<{t:number, dataUrl:string}>) - dataUrl "data:image/jpeg;base64,..."
 */
async function extractFrames(source, opts) {
    const options = Object.assign({ fps: 1, maxFrames: 16, width: 768, quality: 0.7 }, opts || {});
    const url = typeof source === 'string' ? source : URL.createObjectURL(source);
    const ownsBlob = typeof source !== 'string';

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const frames = [];

    try {
        await _waitVideoEvent(video, 'loadedmetadata');
        const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : 15;

        // Sample per detik; video panjang -> interval diperlebar agar tetap <= maxFrames
        const interval = Math.max(1 / options.fps, duration / options.maxFrames);
        const times = [];
        for (let t = interval / 2; t < duration && times.length < options.maxFrames; t += interval) {
            times.push(Math.round(t * 10) / 10);
        }
        if (times.length === 0) times.push(Math.min(0.5, duration / 2));

        const scale = Math.min(1, options.width / (video.videoWidth || options.width));
        canvas.width = Math.max(1, Math.round((video.videoWidth || options.width) * scale));
        canvas.height = Math.max(1, Math.round((video.videoHeight || options.width) * scale));

        for (const t of times) {
            video.currentTime = t;
            await _waitVideoEvent(video, 'seeked');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            frames.push({ t, dataUrl: canvas.toDataURL('image/jpeg', options.quality) });
        }
        if (frames.length === 0) throw new Error('Tidak ada frame berhasil diekstrak');
        return frames;
    } finally {
        video.removeAttribute('src');
        video.load();
        if (ownsBlob) URL.revokeObjectURL(url);
    }
}
