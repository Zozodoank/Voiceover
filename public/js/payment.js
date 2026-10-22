// public/js/payment.js - Modal pembayaran QRIS: order dibuat di Worker, saldo diverifikasi
// lewat polling GET /api/payment/status/:orderId (webhook MacroDroid mengupdate D1 server-side).
let qrisPollTimer = null;

function openTopUpQrisModal() {
    const selectedModelRadio = document.querySelector('input[name="ttsModel"]:checked');
    const basePrice = parseInt(selectedModelRadio.getAttribute('data-price'), 10) || 1200;
    const modelName = selectedModelRadio.parentElement.querySelector('.text-xs.font-bold').innerText;

    apiFetch('/api/payment/create-qris', {
        method: 'POST',
        body: { baseAmount: basePrice, modelLabel: modelName }
    }).then(data => {
        activeOrder = data;
        document.getElementById('qrisModelLabel').innerText = data.modelLabel;
        document.getElementById('qrisBasePriceLabel').innerText = `Rp ${data.baseAmount.toLocaleString('id-ID')}`;
        document.getElementById('qrisUniqueCodeLabel').innerText = `+ Rp ${data.unique2Digit}`;
        document.getElementById('qrisTotalAmountDisplay').innerText = `Rp ${data.totalAmount.toLocaleString('id-ID')}`;
        document.getElementById('qrisPollingStatusText').innerText = "Menunggu webhook MacroDroid...";
        document.getElementById('qrisPaymentModal').classList.remove('hidden');
        startQrisPolling();
    }).catch(err => {
        if (!err.handled) showToast('Gagal membuat pembayaran: ' + err.message, 'error');
    });
}

function startQrisPolling() {
    stopQrisPolling();
    qrisPollTimer = setInterval(() => {
        if (!activeOrder) { stopQrisPolling(); return; }
        apiFetch('/api/payment/status/' + encodeURIComponent(activeOrder.orderId))
            .then(st => {
                if (st.paid) {
                    userBalance = Number(st.balance) || userBalance;
                    userUnlimited = !!st.unlimited;
                    refreshBalanceBadge();
                    document.getElementById('qrisPollingStatusText').innerText = "Pembayaran Berhasil Diverifikasi MacroDroid!";
                    showToast(`Saldo bertambah Rp ${activeOrder.baseAmount.toLocaleString('id-ID')}!`, 'success');
                    stopQrisPolling();
                    setTimeout(() => closeQrisModal(), 1500);
                }
            })
            .catch(() => { /* order kadaluarsa / jaringan sementara - coba lagi tick berikutnya */ });
    }, 5000);
}

function stopQrisPolling() {
    if (qrisPollTimer) { clearInterval(qrisPollTimer); qrisPollTimer = null; }
}

function closeQrisModal() {
    document.getElementById('qrisPaymentModal').classList.add('hidden');
    stopQrisPolling();
}

function copyExactNominal() {
    if (!activeOrder) return;
    const text = String(activeOrder.totalAmount);
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => showToast(`Nominal Rp ${text} disalin!`, 'success'));
    } else {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        showToast(`Nominal Rp ${text} disalin!`, 'success');
    }
}

// Simulasi HANYA untuk uji UI lokal (?dev=1): mengubah tampilan tanpa menyentuh saldo server.
function simulateMacrodroidWebhook() {
    if (!activeOrder) return;
    showToast('Simulasi UI saja - saldo server tidak berubah. Gunakan webhook asli.', 'info');
    document.getElementById('qrisPollingStatusText').innerText = "Pembayaran Berhasil Diverifikasi MacroDroid!";
    setTimeout(() => closeQrisModal(), 1500);
}

// Suntikkan tombol "Tes Sinyal" hanya saat mode dev (?dev=1)
if (location.search.includes('dev=1')) {
    document.addEventListener('DOMContentLoaded', () => {
        const slot = document.getElementById('qrisDevSlot');
        if (slot) slot.innerHTML = '<button onclick="simulateMacrodroidWebhook()" class="px-3 py-1.5 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 text-[11px] font-bold transition"><i class="fa-solid fa-bolt"></i> Tes Sinyal (dev)</button>';
    });
}
