// public/js/state.js - Variabel state global aplikasi (dibagi lintas modul classic script)
// Multi-tenant: CURRENT_USER & userBalance adalah cerminan sesi server (D1) - dimuat tenant.js.
let CURRENT_USER = null;
let userUnlimited = false;
let currentUser = { name: 'Tamu', email: '' };
let userBalance = 0;
let activeOrder = null;
let historyRecords = []; // diisi loadHistoryFromStorage() setelah sesi known (riwayat privat per akun)

let uploadedVideoFile = null;
let generatedScenesData = [];
let generatedCaptionText = "";
let generatedHashtagsText = "";

// Sumber video dari URL lintas-origin (bisa menodai canvas -> ekspor WebM diblokir). Default: file lokal.
let videoSourceIsRemote = false;
// Audio Gemini TTS yang sudah di-prerender per adegan: [{ buffer, duration, blobUrl } | null].
let sceneAudios = [];
let sceneAudiosKey = ""; // signature voice+scenes yang menghasilkan sceneAudios (hindari prerender ulang)
let isPlayingMerged = false; // status pemutaran gabungan aktif
