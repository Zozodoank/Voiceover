// public/js/history.js - Penyimpanan & tampilan riwayat proyek (localStorage ternamespace per user)
const HISTORY_STORAGE_KEY = 'vo_studio_history';

function loadHistoryFromStorage() {
    historyRecords = JSON.parse(tenantGetItem(HISTORY_STORAGE_KEY) || '[]');
}

function persistHistoryRecords() {
    tenantSetItem(HISTORY_STORAGE_KEY, JSON.stringify(historyRecords));
}

function updateHistoryBadge() {
    document.getElementById('historyCountBadge').innerText = historyRecords.length;
}

function saveRecordToHistory(record) {
    historyRecords.unshift(record);
    if (historyRecords.length > 50) historyRecords.pop();
    persistHistoryRecords();
    updateHistoryBadge();
}

function renderHistoryList() {
    const listEl = document.getElementById('historyRecordsList');
    if (!historyRecords.length) {
        listEl.innerHTML = `
            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 text-center text-slate-500 text-xs">
                Belum ada riwayat tersimpan. Selesaikan pembuatan video di tab Studio untuk menyimpannya di sini secara otomatis.
            </div>
        `;
        return;
    }

    listEl.innerHTML = historyRecords.map((item, idx) => `
        <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div class="space-y-1.5 min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="px-2 py-0.5 bg-brand-500/20 text-brand-300 rounded text-[10px] font-bold">#${historyRecords.length - idx}</span>
                    <h3 class="text-sm font-bold text-white truncate">${item.productName}</h3>
                    <span class="px-2 py-0.5 bg-slate-800 text-slate-300 rounded text-[10px] font-mono">${item.modelLabel}</span>
                </div>
                <p class="text-xs text-slate-400 line-clamp-1"><strong>Riset:</strong> ${item.researchSummary}</p>
                <div class="flex items-center gap-3 text-[11px] text-slate-500">
                    <span><i class="fa-regular fa-clock mr-1"></i> ${item.timestamp}</span>
                    <span><i class="fa-solid fa-film mr-1"></i> ${item.scenesCount} Adegan</span>
                    <span><i class="fa-solid fa-venus-mars mr-1"></i> Suara ${item.gender === 'female' ? 'Wanita' : 'Pria'}</span>
                </div>
            </div>
            <div class="flex items-center gap-2 w-full sm:w-auto shrink-0 justify-end">
                <button onclick="loadHistoryRecord(${idx})" class="px-3 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold transition flex items-center gap-1.5">
                    <i class="fa-solid fa-arrow-rotate-left"></i> Muat Ulang
                </button>
                <button onclick="deleteHistoryRecord(${idx})" class="px-2.5 py-2 rounded-xl bg-slate-800 hover:bg-rose-600/20 text-slate-400 hover:text-rose-400 text-xs transition">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function loadHistoryRecord(idx) {
    const item = historyRecords[idx];
    if (!item) return;

    document.getElementById('productNameInput').value = item.productName;
    document.getElementById('affiliateLinkInput').value = item.affiliateLink;
    document.getElementById('captionOutput').value = item.caption;
    document.getElementById('hashtagsOutput').innerText = item.hashtags;
    document.getElementById('productSummaryText').innerText = item.researchSummary;
    document.getElementById('affiliateCardTitle').innerText = item.productName;
    document.getElementById('affiliateLinkDisplay').innerText = item.affiliateLink;
    
    generatedScenesData = item.scenes;
    renderScenesTimeline(generatedScenesData);
    
    document.getElementById('playMergedBtn').removeAttribute('disabled');
    document.getElementById('exportMergedBtn').removeAttribute('disabled');

    switchMainTab('studio');
    showToast(`Proyek "${item.productName}" berhasil dimuat kembali!`, 'success');
}

function deleteHistoryRecord(idx) {
    historyRecords.splice(idx, 1);
    persistHistoryRecords();
    updateHistoryBadge();
    renderHistoryList();
    showToast('Riwayat berhasil dihapus', 'info');
}

function clearHistoryRecords() {
    if (confirm('Hapus seluruh riwayat tersimpan?')) {
        historyRecords = [];
        localStorage.removeItem(namespaceKey(HISTORY_STORAGE_KEY));
        updateHistoryBadge();
        renderHistoryList();
        showToast('Semua riwayat dibersihkan', 'info');
    }
}
