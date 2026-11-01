// public/js/auth.js - Login Google OAuth via Google Identity Services (GIS) + logout.
// ID token dari GIS ditukar jadi cookie sesi HttpOnly di Worker (POST /api/auth/session).

function openAuthModal() {
    document.getElementById('authModal').classList.remove('hidden');
    renderGoogleButton();
}

function closeAuthModal() { document.getElementById('authModal').classList.add('hidden'); }

/** Inisialisasi GIS lalu render tombol resmi Google di modal auth app.html. */
async function renderGoogleButton() {
    const container = document.getElementById('googleBtnContainer');
    if (!container) return;
    if (!window.google || !google.accounts) {
        container.innerHTML = '<p class="text-[11px] text-rose-400">Layanan login Google belum termuat. Periksa koneksi internet Anda.</p>';
        return;
    }
    let clientId = '';
    try {
        const r = await fetch('/api/auth/config', { credentials: 'same-origin' });
        clientId = (await r.json()).clientId || '';
    } catch (e) { /* server offline */ }
    if (!clientId) {
        container.innerHTML = '<p class="text-[11px] text-amber-400">Layanan masuk sedang dalam pemeliharaan. Silakan coba kembali nanti.</p>';
        return;
    }
    google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleCredential,
    });
    container.innerHTML = '';
    google.accounts.id.renderButton(container, {
        theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 280
    });
}

/** Callback GIS: tukar credential dengan cookie sesi di Worker, lalu refresh state lokal. */
async function handleGoogleCredential(resp) {
    try {
        const r = await fetch('/api/auth/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ credential: resp.credential })
        });
        if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            showToast('Gagal masuk akun. Silakan coba beberapa saat lagi.', 'error');
            return;
        }
        await loadSession();
        migrateLegacyTenantData();
        loadHistoryFromStorage();
        applySessionToHeader();
        updateHistoryBadge();
        closeAuthModal();
        showToast(`Berhasil masuk sebagai ${CURRENT_USER.email}`, 'success');
    } catch (e) {
        showToast('Koneksi terganggu. Silakan periksa jaringan Anda.', 'error');
    }
}

async function handleLogout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
    location.href = 'index.html';
}
