// public/js/playback.js - Kontrol pemutaran gabungan & utilitas salin/unduh subtitle.
// Pemutaran & perekaman audio-VO sebenarnya ditangani audio-engine.js (startMergedPlayback/exportMergedVideoWebM).

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

/** Bangun konten SRT nyata dari generatedScenesData (timestamp sesuai adegan). */
function buildSrtContent(scenes) {
    const fmt = (sec) => {
        const ms = Math.round((sec - Math.floor(sec)) * 1000);
        const total = Math.floor(sec);
        const h = String(Math.floor(total / 3600)).padStart(2, '0');
        const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
        const s = String(total % 60).padStart(2, '0');
        return `${h}:${m}:${s},${String(ms).padStart(3, '0')}`;
    };
    return (scenes || []).map((sc, i) =>
        `${i + 1}\n${fmt(Number(sc.start) || 0)} --> ${fmt(Number(sc.end) || 0)}\n${sc.text || ''}\n`
    ).join('\n');
}

function downloadSrtFile() {
    if (!generatedScenesData || !generatedScenesData.length) {
        showToast('Belum ada naskah untuk diekspor sebagai .SRT.', 'error');
        return;
    }
    const srtContent = buildSrtContent(generatedScenesData);
    const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Subtitle_${Date.now()}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('File subtitle .SRT (sesuai adegan) berhasil diunduh!', 'success');
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
