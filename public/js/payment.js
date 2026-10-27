// public/js/payment.js - Modal pembayaran QRIS: order dibuat di Worker, saldo diverifikasi
// lewat polling GET /api/payment/status/:orderId (webhook MacroDroid mengupdate D1 server-side).
let qrisPollTimer = null;

function openTopUpQrisModal(presetAmount) {
    activeOrder = null;
    stopQrisPolling();

    const input = document.getElementById('qrisDepositInput');
    if (input) {
        const preset = Math.round(Number(presetAmount));
        if (Number.isFinite(preset) && preset > 0) input.value = String(preset);
        else if (!input.value) input.value = '50000';
    }
    document.getElementById('qrisBasePriceLabel').innerText = 'Rp 0';
    document.getElementById('qrisUniqueCodeLabel').innerText = '+ Rp 0';
    document.getElementById('qrisTotalAmountDisplay').innerText = 'Rp 0';
    document.getElementById('qrisPollingStatusText').innerText = 'Masukkan nominal lalu tekan "Buat QRIS".';
    document.getElementById('qrisPaymentModal').classList.remove('hidden');
    if (input) input.focus();
}

// Nominal deposit CUSTOM -> Worker menambahkan kode unik 2 digit sebagai validator pembayaran.
function createCustomQrisOrder() {
    const input = document.getElementById('qrisDepositInput');
    const amount = Math.round(Number(input && input.value));
    if (!Number.isFinite(amount) || amount < 1000) {
        showToast('Nominal deposit minimal Rp 1.000.', 'error');
        return;
    }

    const btn = document.getElementById('qrisCreateBtn');
    if (btn) btn.disabled = true;

    apiFetch('/api/payment/create-qris', {
        method: 'POST',
        body: { baseAmount: amount, modelLabel: 'Deposit Saldo' }
    }).then(data => {
        activeOrder = data;
        document.getElementById('qrisBasePriceLabel').innerText = `Rp ${data.baseAmount.toLocaleString('id-ID')}`;
        document.getElementById('qrisUniqueCodeLabel').innerText = `+ Rp ${data.unique2Digit}`;
        document.getElementById('qrisTotalAmountDisplay').innerText = `Rp ${data.totalAmount.toLocaleString('id-ID')}`;
        document.getElementById('qrisPollingStatusText').innerText = 'Menunggu webhook MacroDroid...';
        startQrisPolling();
    }).catch(err => {
        if (!err.handled) showToast('Gagal membuat pembayaran: ' + err.message, 'error');
    }).finally(() => {
        if (btn) btn.disabled = false;
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
