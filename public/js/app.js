// public/js/app.js - Boot sequence: wajib sesi login -> baru muat data tenant & demo.
window.onload = async function () {
    try {
        await loadSession(); // GET /api/me; lempar jika cookie sesi tidak ada/kadaluarsa
    } catch (e) {
        location.replace('index.html'); // landing = pintu masuk OAuth
        return;
    }
    migrateLegacyTenantData();
    loadHistoryFromStorage();
    applySessionToHeader();
    updateHistoryBadge();
    renderVoicePicker();
    document.getElementById('loadDemoBtn').click();
};
