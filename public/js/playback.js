// public/js/playback.js - Putar gabungan video+VO, ekspor, dan utilitas salin/unduh
let isPlayingMerged = false;

function togglePlayMergedVideo() {
    const btnText = document.getElementById('playMergedText');
    const icon = document.getElementById('playMergedIcon');
    isPlayingMerged = !isPlayingMerged;

    if (isPlayingMerged) {
        btnText.innerText = "Jeda";
        icon.className = "fa-solid fa-pause";
        document.getElementById('subtitleOverlayContainer').classList.remove('hidden');
        document.getElementById('sceneOverlayBadge').classList.remove('hidden');
        simulateSubtitlePlayback(0);
        showToast('Memutar video beserta voice over emosi & subtitle...', 'info');
    } else {
        btnText.innerText = "Putar";
        icon.className = "fa-solid fa-play";
        document.getElementById('subtitleOverlayContainer').classList.add('hidden');
        document.getElementById('sceneOverlayBadge').classList.add('hidden');
    }
}

function simulateSubtitlePlayback(sceneIdx) {
    if (!isPlayingMerged || sceneIdx >= generatedScenesData.length) {
        if (sceneIdx >= generatedScenesData.length) {
            isPlayingMerged = false;
            document.getElementById('playMergedText').innerText = "Putar";
            document.getElementById('playMergedIcon').className = "fa-solid fa-play";
            document.getElementById('subtitleOverlayContainer').classList.add('hidden');
            document.getElementById('sceneOverlayBadge').classList.add('hidden');
        }
        return;
    }

    const scene = generatedScenesData[sceneIdx];
    document.getElementById('subtitleOverlayText').innerText = scene.text;
    document.getElementById('currentSceneBadgeText').innerText = `Adegan ${sceneIdx + 1}: ${scene.emotion}`;
    drawDemoCanvasScene(sceneIdx);

    const synth = window.speechSynthesis;
    if (synth) {
        const utter = new SpeechSynthesisUtterance(scene.text);
        utter.lang = 'id-ID';
        synth.speak(utter);
    }

    setTimeout(() => {
        if (isPlayingMerged) simulateSubtitlePlayback(sceneIdx + 1);
    }, 4500);
}

function exportMergedVideoWebM() {
    showToast('Memulai rendering file video gabungan dengan pola emosi (.webm)...', 'info');
    setTimeout(() => {
        const blob = new Blob(["Mock Rendered Video with VO Emotion and Subtitle"], { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `VO_Emotion_${Date.now()}.webm`;
        a.click();
        showToast('Video gabungan emosi berhasil diunduh!', 'success');
    }, 1500);
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

function downloadSrtFile() {
    let srtContent = "1\n00:00:00,000 --> 00:00:05,000\nKulit kusam dan kering? Ini solusinya!\n\n2\n00:00:05,000 --> 00:00:10,000\nMengandung 5X Ceramide untuk skin barrier.\n\n3\n00:00:10,000 --> 00:00:15,000\nCek keranjang kuning sekarang juga!";
    const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Subtitle_Emosi_${Date.now()}.srt`;
    a.click();
    showToast('File subtitle .SRT berpolanya emosi berhasil diunduh!', 'success');
}
