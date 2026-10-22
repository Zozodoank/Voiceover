// public/js/studio.js - Upload/demo video, generator VO & timeline adegan
function playThreeWordPreview(gender) {
    const synth = window.speechSynthesis;
    if (!synth) {
        showToast('Browser SpeechSynthesis tidak didukung', 'error');
        return;
    }
    const utterance = new SpeechSynthesisUtterance("Halo sobat belanja!");
    utterance.lang = 'id-ID';
    utterance.rate = 1.0;
    const voices = synth.getVoices();
    const indonesianVoice = voices.find(v => v.lang.includes('id') || v.lang.includes('ID'));
    if (indonesianVoice) utterance.voice = indonesianVoice;
    synth.speak(utterance);
    showToast(`Memutar preview 3 kata (${gender === 'female' ? 'Wanita' : 'Pria'})...`, 'info');
}

document.getElementById('loadDemoBtn').addEventListener('click', () => {
    isUsingDemoVideo = true;
    document.getElementById('uploadPrompt').classList.add('hidden');
    document.getElementById('uploadSuccess').classList.remove('hidden');
    document.getElementById('fileNameDisplay').innerText = "demo_produk_kecantikan.mp4";
    document.getElementById('videoDurationBadge').innerText = "15.0s";
    document.getElementById('sceneCountBadge').innerText = "3 Segmen";
    document.getElementById('videoEmptyOverlay').classList.add('hidden');
    document.getElementById('productNameInput').value = "Skintific 5X Ceramide Barrier Moisture Gel";
    document.getElementById('affiliateLinkInput').value = "https://shope.ee/8pN9xProdukViralID";
    
    drawDemoCanvasScene(0);
    showToast('Video contoh berhasil dimuat!', 'success');
});

function drawDemoCanvasScene(sceneIdx) {
    const canvas = document.getElementById('demoVideoCanvas');
    canvas.classList.remove('hidden');
    document.getElementById('mainVideo').classList.add('hidden');
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = sceneIdx === 0 ? '#1e1b4b' : sceneIdx === 1 ? '#312e81' : '#4338ca';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px Inter';
    ctx.textAlign = 'center';
    ctx.fillText("Skintific 5X Ceramide Gel", canvas.width/2, canvas.height/2 - 20);
    ctx.font = '16px Inter';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`Adegan Contoh #${sceneIdx + 1} - Pola Emosi Terapan`, canvas.width/2, canvas.height/2 + 20);
}

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
    const gender = document.querySelector('input[name="voiceGender"]:checked').value;

    // Gerbang saldo hanya cermin UI - Worker tetap memvalidasi & mendebit dari D1
    if (!userUnlimited && userBalance < modelPrice) {
        showToast(`Saldo Anda tidak cukup (Rp ${userBalance.toLocaleString('id-ID')}). Harap Top Up QRIS minimal Rp ${modelPrice.toLocaleString('id-ID')}.`, 'error');
        openTopUpQrisModal();
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
    let duration = parseFloat(document.getElementById('videoDurationBadge').innerText) || 15;
    try {
        if (uploadedVideoFile) {
            const frames = await extractFrames(uploadedVideoFile, { fps: 1, maxFrames: 16, width: 768, quality: 0.7 });
            frameDataUrls = frames.map(f => f.dataUrl);
        } else if (isUsingDemoVideo) {
            // Video demo: pakai ilustrasi canvas 3 adegan sebagai frame analisa
            drawDemoCanvasScene(0);
            const c = document.getElementById('demoVideoCanvas');
            frameDataUrls = [c.toDataURL('image/jpeg', 0.7)];
        } else {
            throw new Error('Belum ada video dimuat. Upload video atau klik "Contoh".');
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
                productName,
                affiliateLink: document.getElementById('affiliateLinkInput').value.trim(),
                duration,
                gender,
                modelValue,
                modelLabel: modelName
            }
        });
    } catch (err) {
        statusBox.classList.add('hidden');
        if (err.handled) return;
        if (err.status === 402) {
            const d = err.data || {};
            showToast(`Saldo tidak cukup di server (Rp ${(d.have || 0).toLocaleString('id-ID')}). Top up QRIS dulu ya.`, 'error');
            openTopUpQrisModal();
        } else if (err.status === 502) {
            showToast('Server AI gagal memproses (Gemini & AIVene). Coba lagi sebentar.', 'error');
        } else {
            showToast('Analisa gagal: ' + err.message, 'error');
        }
        return;
    }

    setProgress(90, `<i class="fa-solid fa-circle-notch fa-spin"></i> Menyusun timeline adegan...`);
    const r = resp.result;
    const affLink = document.getElementById('affiliateLinkInput').value;

    if (!userUnlimited && resp.balance != null) userBalance = Number(resp.balance) || 0;
    refreshBalanceBadge();

    generatedProductResearch = r.research || `Riset AI untuk ${productName}: potensi visual kuat untuk konversi affiliate.`;
    document.getElementById('productSummaryText').innerText = generatedProductResearch;

    // Menerapkan Pola Emosi Berbeda di Setiap Adegan (Per Kalimat Voice Over)
    generatedScenesData = r.scenes;
    generatedCaptionText = r.caption || `Wajib punya! ${productName} — cek keranjang kuning sekarang! ✨`;
    generatedHashtagsText = r.hashtags || `#RacunShopee #${productName.replace(/\s+/g, '')} #FYP #SkincareIndonesia`;

    document.getElementById('captionOutput').value = generatedCaptionText;
    document.getElementById('hashtagsOutput').innerText = generatedHashtagsText;
    document.getElementById('affiliateCardTitle').innerText = productName;
    document.getElementById('affiliateLinkDisplay').innerText = affLink;

    renderScenesTimeline(generatedScenesData);

    document.getElementById('playMergedBtn').removeAttribute('disabled');
    document.getElementById('exportMergedBtn').removeAttribute('disabled');
    document.getElementById('activeModelStatusLabel').innerText = `Model: ${modelName} • Suara ${gender === 'female' ? 'Wanita' : 'Pria'} • Emosi Per Adegan Aktif • via ${resp.provider === 'aivene' ? 'AIVene Qwen' : 'Gemini'}`;

    const newRecord = {
        productName,
        affiliateLink: affLink,
        modelLabel: modelName,
        gender,
        researchSummary: generatedProductResearch,
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
}

function renderScenesTimeline(scenes) {
    const container = document.getElementById('scenesContainer');
    container.innerHTML = scenes.map((s, idx) => `
        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
            <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <span class="w-5 h-5 rounded-full bg-brand-500/20 text-brand-400 font-bold text-[11px] flex items-center justify-center shrink-0">${idx + 1}</span>
                    <span class="text-[11px] font-bold text-amber-300 px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded-md">${s.emotion}</span>
                </div>
                <span class="text-[10px] text-slate-400 font-mono">${s.start}s - ${s.end}s</span>
            </div>
            <div class="flex items-center justify-between gap-2">
                <p class="text-xs font-semibold text-slate-200 truncate flex-1">${s.text}</p>
                <button onclick="playSceneAudio('${s.text}', '${s.emotion}')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs shrink-0 flex items-center gap-1">
                    <i class="fa-solid fa-volume-high text-brand-400"></i> Dengar
                </button>
            </div>
        </div>
    `).join('');
}

function playSceneAudio(text, emotion) {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'id-ID';
    utter.rate = emotion.includes('Ceria') ? 1.05 : 0.98;
    synth.speak(utter);
    showToast(`Memutar naskah (${emotion})...`, 'info');
}
