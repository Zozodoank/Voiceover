// public/js/state.js - Variabel state global aplikasi (dibagi lintas modul classic script)
// Multi-tenant: CURRENT_USER & userBalance adalah cerminan sesi server (D1) - dimuat tenant.js.
let CURRENT_USER = null;
let userUnlimited = false;
let currentUser = { name: 'Tamu', email: '' };
let userBalance = 0;
let activeOrder = null;
let historyRecords = []; // diisi loadHistoryFromStorage() setelah sesi known (riwayat privat per akun)

let uploadedVideoFile = null;
let isUsingDemoVideo = false;
let generatedScenesData = [];
let generatedCaptionText = "";
let generatedHashtagsText = "";
let generatedProductResearch = "";
