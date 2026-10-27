// public/js/playback.js - Kontrol pemutaran gabungan & utilitas salin/unduh subtitle.
// Pemutaran & perekaman audio-VO ditangani audio-engine.js. Waktu subtitle SELALU dari timeline
// audio asli (buildTimeline), bukan timestamp perkiraan AI -> SRT sinkron dengan voice over.

function togglePlayMergedVideo() {
    const btnText = document.getElementById('playMergedText');
    const icon = document.getElementById('playMergedIcon');

    if (isPlayingMerged) {
        // Jeda/hentikan
        if (typeof stopEverything === 'function') stopEverything();
        if (typeof resetPlayBtn === 'function') resetPlayBtn();
        return;
    }
    if (!generatedScenesData || !generatedScenesData.length) {
        showToast('Belum ada naskah untuk diputar.', 'error');
        return;
    }
    isPlayingMerged = true;
    btnText.innerText = 'Jeda';
    icon.className = 'fa-solid fa-pause';
    showToast('Memutar video beserta voice over emosi & subtitle (tersinkron)...', 'info');
    startMergedPlayback().catch((e) => {
        showToast('Putar gagal: ' + (e.message || e), 'error');
        resetPlayBtn();
    });
}

/** Bangun konten SRT dari timeline audio ASLI (sama dengan yang dipakai playback & ekspor). */
function buildSrtContent(timeline) {
    const fmt = (sec) => {
        const ms = Math.round((sec - Math.floor(sec)) * 1000);
        const total = Math.floor(sec);
        const h = String(Math.floor(total / 3600)).padStart(2, '0');
        const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
        const s = String(total % 60).padStart(2, '0');
        return `${h}:${m}:${s},${String(ms).padStart(3, '0')}`;
    };
    const segments = (timeline && timeline.segments) || [];
    return segments.map((seg, i) =>
        `${i + 1}\n${fmt(Number(seg.start) || 0)} --> ${fmt(Number(seg.end) || 0)}\n${seg.text || ''}\n`
    ).join('\n');
}

async function downloadSrtFile() {
    if (!generatedScenesData || !generatedScenesData.length) {
        showToast('Belum ada naskah untuk diekspor sebagai .SRT.', 'error');
        return;
    }
    // Subtitle harus memakai waktu audio yang sebenarnya -> pastikan audio adegan sudah siap.
    showToast('Menyiapkan audio agar waktu subtitle presisi…', 'info');
    try {
        await ensureSceneAudios();
        assertAllAudio();
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (msg.indexOf('audio_missing:') === 0) {
            showToast('Suara adegan ' + msg.split(':')[1] + ' gagal dibuat. Coba unduh .SRT sekali lagi.', 'error');
        } else {
            showToast('Gagal menyiapkan audio: ' + msg, 'error');
        }
        return;
    }
    const timeline = (typeof window.getSceneTimeline === 'function') ? window.getSceneTimeline() : buildTimeline();
    if (!timeline.segments.length) {
        showToast('Belum ada audio adegan untuk dihitung. Buat ulang Voice Over.', 'error');
        return;
    }
    const srtContent = buildSrtContent(timeline);
    const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Subtitle_${Date.now()}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('File subtitle .SRT (sinkron dengan voice over) berhasil diunduh!', 'success');
}

function copyCaptionAndHashtags() {
    const fullText = document.getElementById('captionOutput').value + "\n\n" + document.getElementById('hashtagsOutput').innerText;
    const ta = document.createElement('textarea');
    ta.value = fullText;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Caption & Hashtag berhasil disalin!', 'success');
}

function copyAffiliateBox() {
    const link = document.getElementById('affiliateLinkDisplay').innerText;
    const ta = document.createElement('textarea');
    ta.value = link;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Link affiliate berhasil disalin!', 'success');
}
