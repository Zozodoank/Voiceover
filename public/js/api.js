// public/js/api.js - Helper fetch JSON dengan kredensial same-origin + penanganan 401 terpusat.
async function apiFetch(path, options) {
    const opts = Object.assign({ credentials: 'same-origin' }, options || {});
    if (opts.body && typeof opts.body !== 'string') {
        opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    if (res.status === 401) {
        // Sesi hilang/kadaluarsa -> kembali ke landing untuk login Google
        showToast('Sesi berakhir, silakan login ulang.', 'error');
        setTimeout(() => { location.href = 'index.html'; }, 1200);
        const err = new Error('unauthorized');
        err.status = 401;
        err.handled = true;
        throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* respons non-JSON */ }
    if (!res.ok) {
        const err = new Error((data && (data.message || data.error)) || 'HTTP ' + res.status);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}
