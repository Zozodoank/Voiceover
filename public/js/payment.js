// public/js/payment.js - Modal pembayaran QRIS DUA LANGKAH: user mengisi nominal deposit lalu menekan
// Bayar; QRIS (beserta 2 digit kode unik di belakang nominal) baru ditampilkan setelah order dibuat.
// Verifikasi saldo lewat polling GET /api/payment/status/:orderId (webhook MacroDroid update D1 server-side).
// QRIS dinamis: gambar QR berisi nominal terkunci (/api/payment/qr/:orderId?s=token).
// Bila payload statis belum diatur admin, otomatis kembali ke gambar QRIS statis + input 2 digit manual.
let qrisPollTimer = null;
let qrisCountdownTimer = null;
let qrisPanelStep = 'input';   // 'input' = QRIS belum ditampilkan, 'qr' = QRIS sudah tampil
let qrisOrderStale = false;    // nominal diubah setelah QR tampil -> perlu "Buat Ulang"

const QRIS_MIN_INPUT = 1000;
const QRIS_MAX_INPUT = 10000000;

function toggleQrisHidden(id, hidden) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !!hidden);
}

/** Langkah 1 (isi nominal) vs langkah 2 (QRIS tampil) - satu sumber kebenaran untuk tampilan modal. */
function setQrisStep(step) {
    qrisPanelStep = step === 'qr' ? 'qr' : 'input';
    const isQr = qrisPanelStep === 'qr';
    toggleQrisHidden('qrisQrPanel', !isQr);
    toggleQrisHidden('qrisQrPlaceholder', isQr);
    markQrisStale(false);
    const label = document.getElementById('qrisCreateBtnText');
    if (label) label.textContent = isQr ? 'Buat Ulang' : 'Bayar';
}

/** Beri aksen pada tombol utama saat nominal diubah setelah QRIS tampil. */
function markQrisStale(isStale) {
    qrisOrderStale = !!isStale;
    const btn = document.getElementById('qrisCreateBtn');
    if (!btn) return;
    btn.classList.toggle('ring-2', qrisOrderStale);
    btn.classList.toggle('ring-amber-500', qrisOrderStale);
}

function setQrisAmountError(message) {
    const el = document.getElementById('qrisAmountError');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}

function setQrisAmountHint(message) {
    const el = document.getElementById('qrisAmountHint');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}

/** Kunci tombol utama selama request agar order tidak dibuat dua kali. */
function setQrisBusy(isBusy) {
    const btn = document.getElementById('qrisCreateBtn');
    const label = document.getElementById('qrisCreateBtnText');
    if (btn) btn.disabled = !!isBusy;
    if (label) label.textContent = isBusy ? 'Menyiapkan QRIS...' : (qrisPanelStep === 'qr' ? 'Buat Ulang' : 'Bayar');
}

function openTopUpQrisModal(presetAmount) {
    activeOrder = null;
    stopQrisPolling();
    stopQrisCountdown();

    const input = document.getElementById('qrisDepositInput');
    if (input) {
        const preset = Math.round(Number(presetAmount));
        if (Number.isFinite(preset) && preset > 0) input.value = String(preset);
        else if (!input.value) input.value = '50000';
    }

    // QRIS sengaja belum dimuat: gambar baru diambil setelah user menekan Bayar.
    const img = document.getElementById('qrisImageDisplay');
    if (img) {
        img.removeAttribute('src');
        img.style.display = '';
        img.style.opacity = '1';
    }
    const fallback = document.getElementById('qrisFallbackSvg');
    if (fallback) { fallback.classList.add('hidden'); fallback.classList.remove('flex'); }

    setQrisStep('input');
    setQrisDynamic(false);
    setQrisAmountError('');
    setQrisAmountHint('');
    setQrisBusy(false);
    document.getElementById('qrisBasePriceLabel').innerText = 'Rp 0';
    document.getElementById('qrisUniqueCodeLabel').innerText = 'otomatis';
    document.getElementById('qrisTotalAmountDisplay').innerText = '\u2014';
    onQrisAmountInput();
    document.getElementById('qrisPollingStatusText').innerText = 'Isi nominal deposit lalu tekan Bayar.';
    document.getElementById('qrisPaymentModal').classList.remove('hidden');
    if (input) input.focus();
}

/** Cermin nominal di panel: langkah 1 hanya nominal; langkah 2 dibandingkan dengan order aktif. */
function onQrisAmountInput() {
    const input = document.getElementById('qrisDepositInput');
    const raw = Math.round(Number(input && input.value));
    const valid = Number.isFinite(raw) && raw >= QRIS_MIN_INPUT && raw <= QRIS_MAX_INPUT;
    // Nominal dibulatkan ke bawah ke kelipatan 100 agar 2 digit kode unik ada di akhir total.
    const base = valid ? raw - (raw % 100) : 0;
    document.getElementById('qrisBasePriceLabel').innerText = base ? `Rp ${base.toLocaleString('id-ID')}` : 'Rp 0';

    if (qrisPanelStep !== 'qr') {
        document.getElementById('qrisUniqueCodeLabel').innerText = 'otomatis';
        document.getElementById('qrisTotalAmountDisplay').innerText = '\u2014';
        return;
    }

    const stale = !!(activeOrder && (!valid || base !== activeOrder.baseAmount));
    markQrisStale(stale);
    if (stale) {
        document.getElementById('qrisUniqueCodeLabel').innerText = 'perlu Buat Ulang';
        setQrisAmountHint('Nominal berubah - tekan "Buat Ulang" untuk QR baru.');
        document.getElementById('qrisPollingStatusText').innerText = 'Nominal berubah - tekan "Buat Ulang".';
    } else if (activeOrder) {
        document.getElementById('qrisUniqueCodeLabel').innerText = `+ Rp ${activeOrder.unique2Digit}`;
        setQrisAmountHint('');
        document.getElementById('qrisPollingStatusText').innerText = activeOrder.qrUrl
            ? 'Nominal terkunci. Scan QRIS lalu bayar - verifikasi otomatis.'
            : 'Menunggu webhook MacroDroid...';
    }
}

/** Tampilkan/sembunyikan elemen khusus QRIS dinamis (badge, hitung mundur, tombol unduh). */
function setQrisDynamic(isDynamic) {
    toggleQrisHidden('qrisDynamicBadge', !isDynamic);
    toggleQrisHidden('qrisCountdown', !isDynamic);
    toggleQrisHidden('qrisDownloadBtn', !isDynamic);
    const warning = document.getElementById('qrisWarningText');
    if (!warning) return;
    if (isDynamic) {
        warning.innerHTML = '<i class="fa-solid fa-circle-check mr-1"></i>Nominal <strong>sudah terkunci</strong> di QRIS - cukup scan dan bayar.';
    } else if (qrisPanelStep === 'qr') {
        warning.innerHTML = '<i class="fa-solid fa-triangle-exclamation mr-1"></i><strong>Penting:</strong> Transfer <strong>persis sampai 2 digit terakhir</strong> agar MacroDroid otomatis memverifikasi!';
    } else {
        warning.innerHTML = '<i class="fa-solid fa-lock mr-1"></i>Nominal deposit akan dikunci otomatis di QRIS setelah kamu menekan <strong>Bayar</strong>.';
    }
}

// Nominal deposit CUSTOM -> Worker menambahkan kode unik 2 digit sebagai validator pembayaran.
function createCustomQrisOrder() {
    const input = document.getElementById('qrisDepositInput');
    const amount = Math.round(Number(input && input.value));
    setQrisAmountError('');
    setQrisAmountHint('');

    if (!Number.isFinite(amount) || amount < QRIS_MIN_INPUT) {
        setQrisAmountError('Nominal deposit minimal Rp 1.000.');
        if (input) input.focus();
        return;
    }
    if (amount > QRIS_MAX_INPUT) {
        setQrisAmountError('Nominal deposit maksimal Rp 10.000.000.');
        return;
    }

    // 2 digit terakhir total harus milik kode unik -> nominal wajib kelipatan 100.
    const baseAmount = amount - (amount % 100);
    if (baseAmount !== amount) {
        if (input) input.value = String(baseAmount);
        setQrisAmountHint(`Disesuaikan ke Rp ${baseAmount.toLocaleString('id-ID')} agar 2 digit kode verifikasi berada di akhir nominal.`);
    }

    setQrisBusy(true);
    apiFetch('/api/payment/create-qris', {
        method: 'POST',
        body: { baseAmount, modelLabel: 'Deposit Saldo' }
    }).then(data => {
        activeOrder = data;
        renderQrisReveal(data);
    }).catch(err => {
        if (err.handled) return;
        setQrisAmountError('Gagal membuat pembayaran: ' + err.message);
        if (qrisPanelStep === 'input') document.getElementById('qrisPollingStatusText').innerText = 'Order belum dibuat - tekan Bayar untuk mencoba lagi.';
    }).finally(() => {
        setQrisBusy(false);
    });
}

/** Langkah 2: tampilkan QRIS + nominal terkunci (dinamis) atau QRIS statis (fallback). */
function renderQrisReveal(data) {
    const img = document.getElementById('qrisImageDisplay');
    if (img) {
        img.style.display = '';
        img.style.opacity = '1';
        img.src = data.qrUrl || ('/api/qris/image?t=' + Date.now());
    }
    const fallback = document.getElementById('qrisFallbackSvg');
    if (fallback) { fallback.classList.add('hidden'); fallback.classList.remove('flex'); }

    document.getElementById('qrisBasePriceLabel').innerText = `Rp ${data.baseAmount.toLocaleString('id-ID')}`;
    document.getElementById('qrisUniqueCodeLabel').innerText = `+ Rp ${data.unique2Digit}`;
    document.getElementById('qrisTotalAmountDisplay').innerText = `Rp ${data.totalAmount.toLocaleString('id-ID')}`;

    setQrisStep('qr');
    setQrisDynamic(!!data.qrUrl);
    document.getElementById('qrisPollingStatusText').innerText = data.qrUrl
        ? 'Nominal terkunci. Scan QRIS lalu bayar - verifikasi otomatis.'
        : 'Menunggu webhook MacroDroid...';
    if (data.qrUrl) startQrisCountdown(data.expiresAt);

    const panel = document.getElementById('qrisQrPanel');
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    startQrisPolling();
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
                    stopQrisCountdown();
                    setTimeout(() => closeQrisModal(), 1500);
                }
            })
            .catch(err => {
                // Order kedaluwarsa (KV TTL habis): berhenti polling, minta user membuat QRIS baru.
                if (err && err.status === 404) {
                    stopQrisPolling();
                    stopQrisCountdown();
                    // Badge/countdown disembunyikan; tombol utama otomatis berlabel "Buat Ulang".
                    const badge = document.getElementById('qrisDynamicBadge');
                    if (badge) badge.classList.add('hidden');
                    const countdown = document.getElementById('qrisCountdown');
                    if (countdown) countdown.classList.add('hidden');
                    const img = document.getElementById('qrisImageDisplay');
                    if (img) img.style.opacity = '.35';
                    document.getElementById('qrisPollingStatusText').innerText = 'QRIS kedaluwarsa - tekan "Buat Ulang" untuk nominal baru.';
                }
                /* error jaringan sementara: coba lagi tick berikutnya */
            });
    }, 5000);
}

function stopQrisPolling() {
    if (qrisPollTimer) { clearInterval(qrisPollTimer); qrisPollTimer = null; }
}

/** Hitung mundur masa berlaku QRIS dinamis (dari expiresAt server). */
function startQrisCountdown(expiresAt) {
    stopQrisCountdown();
    const el = document.getElementById('qrisCountdown');
    if (!el || !expiresAt) return;
    const tick = () => {
        const remain = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
        const mm = String(Math.floor(remain / 60)).padStart(2, '0');
        const ss = String(remain % 60).padStart(2, '0');
        el.classList.remove('hidden');
        el.innerText = remain > 0 ? `Sisa waktu ${mm}:${ss}` : 'QRIS kedaluwarsa - tekan Buat Ulang';
        if (remain === 0) {
            const img = document.getElementById('qrisImageDisplay');
            if (img) img.style.opacity = '.35';
        }
    };
    tick();
    qrisCountdownTimer = setInterval(tick, 1000);
}

function stopQrisCountdown() {
    if (qrisCountdownTimer) { clearInterval(qrisCountdownTimer); qrisCountdownTimer = null; }
}

/** Gambar QRIS dinamis gagal dimuat (sesi hilang / order kedaluwarsa). */
function onQrisImageError() {
    const img = document.getElementById('qrisImageDisplay');
    const fallback = document.getElementById('qrisFallbackSvg');
    if (img) img.style.display = 'none';
    if (fallback) { fallback.classList.remove('hidden'); fallback.classList.add('flex'); }
    const status = document.getElementById('qrisPollingStatusText');
    if (status) status.innerText = 'QRIS dinamis gagal dimuat - tekan "Buat Ulang".';
}

function closeQrisModal() {
    document.getElementById('qrisPaymentModal').classList.add('hidden');
    stopQrisPolling();
    stopQrisCountdown();
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

/** Unduh SVG QRIS dinamis (memudahkan pembayaran dari HP lain). */
function downloadQrisSvg() {
    if (!activeOrder || !activeOrder.qrUrl) return;
    fetch(activeOrder.qrUrl, { credentials: 'same-origin' })
        .then(res => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.blob();
        })
        .then(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `QRIS-${activeOrder.orderId}.svg`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            showToast('QRIS diunduh.', 'success');
        })
        .catch(() => showToast('Gagal mengunduh QRIS.', 'error'));
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
