const NAV_BTN_BASE = "px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition flex items-center gap-1 sm:gap-1.5 whitespace-nowrap";

// public/js/ui.js - Navigasi tab utama & notifikasi toast
function switchMainTab(tabName) {
    const studioView = document.getElementById('tabStudioView');
    const historyView = document.getElementById('tabHistoryView');
    const navStudioBtn = document.getElementById('navStudioBtn');
    const navHistoryBtn = document.getElementById('navHistoryBtn');

    const activeCls = NAV_BTN_BASE + " bg-brand-600 text-white";
    const idleCls = NAV_BTN_BASE + " text-slate-400 hover:text-white";

    if (tabName === 'studio') {
        studioView.classList.remove('hidden');
        historyView.classList.add('hidden');
        navStudioBtn.className = activeCls;
        navHistoryBtn.className = idleCls;
    } else {
        studioView.classList.add('hidden');
        historyView.classList.remove('hidden');
        navHistoryBtn.className = activeCls;
        navStudioBtn.className = idleCls;
        renderHistoryList();
    }
}

function showToast(text, type='info') {
    const box = document.getElementById('toastBox');
    const txt = document.getElementById('toastText');
    const icon = document.getElementById('toastIcon');
    txt.innerText = text;
    icon.className = type === 'success' ? 'fa-solid fa-circle-check text-emerald-400 text-lg shrink-0' :
                     type === 'error' ? 'fa-solid fa-triangle-exclamation text-rose-400 text-lg shrink-0' :
                     'fa-solid fa-circle-info text-brand-400 text-lg shrink-0';
    box.classList.remove('hidden');
    setTimeout(() => box.classList.add('hidden'), 4000);
}

function hideToast() { document.getElementById('toastBox').classList.add('hidden'); }

// Perbarui badge saldo header; superadmin (unlimited) tampil "Tanpa Batas"
function refreshBalanceBadge() {
    const badge = document.getElementById('userBalanceBadge');
    if (!badge) return;
    badge.innerText = userUnlimited ? '∞ Tanpa Batas' : `Rp ${userBalance.toLocaleString('id-ID')}`;
}
