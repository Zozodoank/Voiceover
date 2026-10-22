// public/js/deploy.js - Pusat Unduh: mengambil file proyek asli dari server (bukan string embedded)
// Pemetaan tombol lama -> path relatif file terhadap root proyek (harus ada di whitelist server).
const DEPLOY_FILE_MAP = {
    html: 'public/app.html',
    server: 'worker/index.js',
    bat: 'start_app.bat',
    github_bat: 'push_to_github.bat',
    gitignore: '.gitignore',
    env: 'ENV_TEMPLATE.env',
    macro: 'qris_megakomindo_verifier.macro'
};

function openDeployCenterModal() { document.getElementById('deployCenterModal').classList.remove('hidden'); }
function closeDeployCenterModal() { document.getElementById('deployCenterModal').classList.add('hidden'); }

// Ambil satu file teks dari server lewat route whitelist /api/download.
async function fetchProjectFile(relPath) {
    const encoded = relPath.split('/').map(encodeURIComponent).join('/');
    const res = await fetch('/api/download/file/' + encoded);
    if (!res.ok) throw new Error('Gagal mengambil ' + relPath + ' (HTTP ' + res.status + ')');
    return await res.text();
}

function triggerBrowserDownload(content, filename, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

async function downloadDeploymentFile(type) {
    const relPath = DEPLOY_FILE_MAP[type];
    if (!relPath) {
        showToast('Jenis file tidak dikenal.', 'error');
        return;
    }
    const filename = relPath.split('/').pop();
    try {
        const content = await fetchProjectFile(relPath);
        triggerBrowserDownload(content, filename);
        showToast(`Berhasil mengunduh ${filename}!`, 'success');
    } catch (err) {
        console.error(err);
        showToast('Hubungkan ke server lokal untuk mengunduh file...', 'error');
    }
}

async function downloadAllAsZip() {
    const btn = document.getElementById('zipDownloadBtn');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Membuat File ZIP...`;
    btn.disabled = true;

    try {
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip library belum siap.');
        }
        const listRes = await fetch('/api/download/files');
        if (!listRes.ok) throw new Error('Daftar unduhan tidak tersedia (HTTP ' + listRes.status + ').');
        const { files } = await listRes.json();
        if (!files || !files.length) throw new Error('Daftar file kosong.');

        const zip = new JSZip();
        for (const relPath of files) {
            const content = await fetchProjectFile(relPath);
            zip.file(relPath, content);
        }

        const content = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = "VO-Affiliate-Studio-Enterprise.zip";
        a.click();
        URL.revokeObjectURL(url);
        showToast("Berhasil mengunduh seluruh file proyek dalam satu paket ZIP!", "success");
    } catch (err) {
        console.error(err);
        showToast("Gagal membuat zip otomatis: " + err.message, "error");
    } finally {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
    }
}
