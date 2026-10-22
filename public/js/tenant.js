// public/js/tenant.js - Multi-tenant: sesi user aktif + namespace localStorage per akun Google.
// Dimuat sebagai classic script SEBELUM modul lain yang memakai CURRENT_USER/namespaceKey.

// CURRENT_USER diisi dari GET /api/me (lihat app.js boot sequence)
function namespaceKey(key) {
    return key + ':' + ((typeof CURRENT_USER !== 'undefined' && CURRENT_USER && CURRENT_USER.sub) ? CURRENT_USER.sub : 'guest');
}

function tenantGetItem(key) { return localStorage.getItem(namespaceKey(key)); }
function tenantSetItem(key, value) { localStorage.setItem(namespaceKey(key), value); }

/** Muat profil sesi dari Worker; lempar Error jika belum login (panggilan di-handle app.js). */
async function loadSession() {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('no-session');
    const me = await r.json();
    CURRENT_USER = me;
    currentUser = { name: me.name, email: me.email };
    userBalance = Number(me.balance) || 0;
    userUnlimited = !!me.unlimited;
    return me;
}

/** Pindahkan data lama (pra-multi-tenant, key tanpa suffix) ke namespace user aktif - sekali jalan. */
function migrateLegacyTenantData() {
    const legacyKey = 'vo_studio_history';
    const doneMark = legacyKey + ':__migrated__';
    if (!localStorage.getItem(legacyKey) || localStorage.getItem(doneMark)) return;
    const target = namespaceKey(legacyKey);
    if (!localStorage.getItem(target)) {
        localStorage.setItem(target, localStorage.getItem(legacyKey));
    }
    localStorage.setItem(doneMark, 'moved');
    localStorage.removeItem(legacyKey);
}

/** Terapkan profil sesi ke elemen header (nama, saldo/∞, tombol admin & keluar). */
function applySessionToHeader() {
    const label = document.getElementById('authUserLabel');
    if (label) label.innerText = (CURRENT_USER && (CURRENT_USER.name || CURRENT_USER.email)) || 'Masuk';
    const logoutBtn = document.getElementById('logoutHeaderBtn');
    if (logoutBtn) logoutBtn.classList.toggle('hidden', !CURRENT_USER);
    const adminBtn = document.getElementById('adminHeaderBtn');
    if (adminBtn) {
        adminBtn.classList.remove('hidden');
        adminBtn.classList.add('flex');
        if (!CURRENT_USER || !CURRENT_USER.unlimited) {
            adminBtn.classList.add('hidden');
            adminBtn.classList.remove('flex');
        }
    }
    refreshBalanceBadge();
}
