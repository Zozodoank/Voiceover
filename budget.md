# Rincian Biaya Produksi (COGS) per 1 Output Video

Dokumen ini merinci perhitungan biaya produksi API (analisa visual video, pembuatan naskah/script per adegan, penentuan emosi, pembuatan caption & hashtag, hingga sintesis suara Text-to-Speech/TTS) untuk **1 kali generate output video** berdasarkan arsitektur kode aktual pada proyek ini.

> **Kurs Real-Time & Parameter Standar Produksi:**
> - **Kurs Real-Time Saat Ini (7 Nov 2026 — Mid-Market Live Rate):** **`1 USD = Rp 18.100`** *(data live `open.er-api.com` / Wise / XE: Rp 18.098,98 – Rp 18.104)*
> - **Durasi Video Rata-rata:** `15 – 25 detik` (rata-rata panjang audio VO: **~20 detik**, ~45–50 kata / ~320 karakter)
> - **Ekstraksi Visual (`public/js/studio.js`):** Maksimal **6 frame JPEG** beresolusi `320px` (`quality: 0.65`) per video.
> - **Optimasi TTS (`public/js/audio-engine.js`):** **1 video = 1 panggilan API TTS** (seluruh adegan digabung menjadi satu naskah, lalu dipotong otomatis per adegan di browser tanpa biaya tambahan).
> - **Render Video + Subtitle Burn-in + File `.SRT`:** Diproses **100% di sisi browser (Client-Side WebAudio + Canvas + MediaRecorder)** sehingga biaya server render = **Rp 0**.
> - **Pratinjau Contoh Suara (Tombol ▶):** Menggunakan 14 file sampel WAV statis (`public/audio/voices/*.wav`), sehingga biaya API = **Rp 0**.

---

## 1. Volume Token per 1 Job Video

### A. Tahap Analisa Video, Script, Emosi, Caption & Hashtag (`POST /api/analyze`)
| Komponen Input / Output | Perhitungan Teknis (`worker/lib/ai.js`) | Jumlah Token |
| :--- | :--- | ---: |
| **Input Gambar (6 Frame Video)** | 6 frame JPEG (`width: 320px` ≤ 384px) × `258 token/frame` | **1.548 token** |
| **Input Teks Prompt (`buildAnalysisPrompt`)** | Instruksi timestamp, anggaran kata, emosi, CTA & skema JSON (~1.650 karakter) | **420 token** |
| **Total Input Analisa** | `1.548 + 420 token` (dibulatkan) | **~2.000 token** |
| **Total Output Analisa (JSON)** | `research` + `4–6 scenes` + `caption` + `hashtags` (`thinkingBudget: 0`, ~1.500 karakter) | **~400 token** |

### B. Tahap Sintesis Suara / Voice Over (`POST /api/tts/preview`)
| Komponen Input / Output | Perhitungan Teknis (`worker/lib/tts.js`) | Jumlah Token / Karakter |
| :--- | :--- | ---: |
| **Input Teks Naskah (`stylePrompt`)** | Teks naskah murni gabungan 4–6 adegan (~48 kata / ~320 karakter, tanpa prompt sistem) | **~80 token teks** |
| **Output Audio Suara (20 detik)** | Standar tokenisasi audio Gemini (`32 token audio / detik` × `20 detik`) | **~640 token audio** |
| **Output Audio Suara (Video Maks 30 detik)** | `32 token audio / detik` × `30 detik` | **~960 token audio** |

---

## 2. Perbandingan Biaya Tahap 1: Analisa, Script, Caption & Hashtag (Gemini Free Tier vs Fallback Tunggal `qwen3.8-flash`)

Urutan rantai model di `wrangler.toml` & `worker/lib/ai.js` (**4 model Gemini Free Tier** -> **fallback tunggal AIVene `qwen3.8-flash`** setelah kuota gratis Gemini habis) dengan kurs real-time **`Rp 18.100 / USD`**:

| Model Analisa & Copywriting | Peran di Sistem (`worker/lib/ai.js`) | Tarif Input / 1M Token | Tarif Output / 1M Token | Biaya Input (2.000 tok) | Biaya Output (400 tok) | **Total Biaya per 1 Video (USD)** | **Total Biaya per 1 Video (IDR)** | Status Kuota & Kebijakan |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| **`gemini-3.1-flash-lite`** | **Gemini Utama (#1)** | \$0.25 | \$1.50 | \$0.000500 | \$0.000600 | **\$0.001100** | **Rp 19,91** | **Gratis** (Free Tier Google) |
| **`gemini-3-flash-preview`** | Fallback Gemini Free (#2) | \$0.50 | \$3.00 | \$0.001000 | \$0.001200 | **\$0.002200** | **Rp 39,82** | **Gratis** (`thinkingBudget: 0`) |
| **`gemini-3.1-flash-lite-preview`** | Fallback Gemini Free (#3) | \$0.25 | \$1.50 | \$0.000500 | \$0.000600 | **\$0.001100** | **Rp 19,91** | **Gratis** (Free Tier Google) |
| **`gemini-3.5-flash-lite`** | Fallback Gemini Free (#4) | \$0.25 | \$1.50 | \$0.000500 | \$0.000600 | **\$0.001100** | **Rp 19,91** | **Gratis** (Free Tier Google) |
| **`qwen3.8-flash`** *(via AIVene)* | **Fallback Tunggal Setelah Kuota Gratis Gemini Habis** | \$0.15 | \$0.47 | \$0.000300 | \$0.000188 | **\$0.000488** | **Rp 8,83** | Berbayar sangat hemat (Saldo AIVene) |

> **Proteksi Anti Kebocoran Token Analisa (`worker/lib/ai.js`):**
> - Model mahal non-free-tier (`gemini-3.5-flash` & `gemini-3.6-flash`) telah **dihapus & diblokir** dari rotasi.
> - `maxOutputTokens` diperketat menjadi `800` token (Gemini) dan `max_tokens: 700` (AIVene `qwen3.8-flash`).
> - `thinkingConfig: { thinkingBudget: 0 }` dipasang khusus pada model non-lite sehingga tidak ada token yang terbuang untuk *internal reasoning* maupun *double-request retry*.

---

## 3. Perbandingan Biaya Tahap 2: Model Text-to-Speech (Gemini Direct & AIVene Menggunakan Model TTS yang Sama)

Baik **Gemini Direct** (utama saat kuota gratis tersedia) maupun **AIVene** (fallback saat kuota gratis Gemini habis) menggunakan **model TTS Gemini dan karakter suara Gemini yang sama persis** (model `tts-1` dan `gemini-2.5-pro-preview-tts` telah **dihapus & diblokir**).

Perhitungan di bawah adalah untuk **1 video (durasi suara rata-rata ~20 detik = 80 token teks input + 640 token audio output, ~320 karakter, `TTS_MAX_TEXT = 800`)** dengan kurs real-time **`Rp 18.100 / USD`**:

| Model TTS Gemini (Identik di Gemini Direct & AIVene) | Tier Kualitas di UI | Tarif Input Teks | Tarif Output Audio | Biaya per 1 Video 20 dtk (USD) | **Biaya per 1 Video 20 dtk (IDR)** | Biaya Video Maks 30 dtk (IDR) | Kuota Gemini Direct -> Fallback AIVene |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- |
| **`gemini-3.8-flash-lite-tts`** | **Tier Normal** *(Utama)* | \$0.25 / 1M tok | \$6.00 / 1M tok audio | \$0.003860 | **Rp 69,87** | Rp 104,80 | **Gratis 10 req/hari** -> lanjut AIVene (`gemini-3.8-flash-lite-tts`) |
| **`gemini-3.1-flash-tts-preview`** *(Direct)* / **`gemini-3.1-flash-tts`** *(AIVene)* | **Tier Sedang** *(Utama)* | \$0.50 / 1M tok | \$9.00 / 1M tok audio | \$0.005800 | **Rp 104,98** | Rp 157,47 | **Gratis 10 req/hari** -> lanjut AIVene (`gemini-3.1-flash-tts`) |
| **`gemini-3.8-flash-tts`** | **Tier Tinggi** *(Utama)* | \$0.50 / 1M tok | \$9.00 / 1M tok audio | \$0.005800 | **Rp 104,98** | Rp 157,47 | **Gratis 10 req/hari** -> lanjut AIVene (`gemini-3.8-flash-tts`) |
| **`gemini-2.5-flash-preview-tts`** *(Direct)* / **`gemini-2.5-flash-tts`** *(AIVene)* | Fallback Cadangan (#4) | \$0.50 / 1M tok | \$10.00 / 1M tok audio | \$0.006440 | **Rp 116,56** | Rp 174,85 | **Gratis 10 req/hari** -> lanjut AIVene (`gemini-2.5-flash-tts`) |

> **Proteksi Anti Kebocoran Token Audio (`worker/lib/tts.js`):**
> - Hanya mengirim teks naskah murni (`stylePrompt(text)`) tanpa menyisipkan instruksi sistem yang sebelumnya membocorkan ~20 detik token audio per panggilan.
> - `TTS_MAX_TEXT` diperketat dari `4000` menjadi **`800` karakter** dan hasil audio disimpan di KV Cache selama **30 hari** (`X-Tts-Cache: hit` = 0 token).

---

## 4. Total Biaya Produksi (HPP / COGS) per 1 Output Video vs Harga Jual

Biaya infrastruktur Cloudflare Workers, D1 Database, dan KV Cache (dengan masa simpan cache audio 30 hari di `worker/routes/tts.js`) berada di dalam kuota gratis Cloudflare (100.000 request/hari), atau kurang dari **Rp 1 per video** pada paket berbayar.

### A. Skenario Setelah Kuota Gratis Habis (Fallback ke AIVene `qwen3.8-flash` + Model TTS Gemini yang Sama)

| Paket / Kombinasi Model (Analisa + TTS) | Biaya Analisa (`qwen3.8-flash`) | Biaya Suara TTS Gemini | **Total HPP / COGS per 1 Video** | Harga Jual ke User (`pricing.js`) | **Laba Bersih per 1 Video** | **Margin Laba** |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **Tier Normal**<br>`qwen3.8-flash` + `gemini-3.8-flash-lite-tts` | Rp 8,83 | Rp 69,87 | **Rp 78,70** | **Rp 1.200** | **+Rp 1.121,30** | **93,4%** |
| **Tier Sedang**<br>`qwen3.8-flash` + `gemini-3.1-flash-tts` | Rp 8,83 | Rp 104,98 | **Rp 113,81** | **Rp 1.500** | **+Rp 1.386,19** | **92,4%** |
| **Tier Tinggi**<br>`qwen3.8-flash` + `gemini-3.8-flash-tts` | Rp 8,83 | Rp 104,98 | **Rp 113,81** | **Rp 1.800** | **+Rp 1.686,19** | **93,7%** |

### B. Skenario Free Tier Gemini Direct (40 Video Pertama per Hari)
- Selama kuota harian Google AI Studio Free Tier masih tersedia (**4 model Gemini TTS × 10 request/hari = 40 video/hari**), biaya API untuk analisa maupun TTS adalah **Rp 0 per video** (margin **100%**).
- Begitu kuota gratis Gemini habis, sistem otomatis beralih ke **AIVene (`qwen3.8-flash` + model TTS Gemini yang sama)** dengan total modal produksi hanya **Rp 78,70 s/d Rp 113,81 per video** (margin laba **92,4% – 93,7%**).

---

## 5. Simulasi Biaya & Keuntungan Bulanan (1.000 Video / Bulan — Kurs Rp 18.100/USD)

| Metrik | Menggunakan Free Tier + Fallback | Menggunakan Paid API Penuh (`gemini-3.1-flash-lite` + `gemini-3.8-flash-tts`) | Menggunakan `qwen3.8-flash` + `gemini-3.8-flash-lite-tts` |
| :--- | ---: | ---: | ---: |
| **Volume Produksi** | 1.000 Video | 1.000 Video | 1.000 Video |
| **Biaya Analisa & Script (1.000x)** | Rp 0 | Rp 19.910 | Rp 8.830 |
| **Biaya Sintesis TTS (1.000x)** | Rp 0 | Rp 104.980 | Rp 69.870 |
| **Total Modal Produksi (HPP)** | **Rp 0** | **Rp 124.890** | **Rp 78.700** |
| **Pendapatan Kotor (Rata-rata Rp 1.500/video)** | Rp 1.500.000 | Rp 1.500.000 | Rp 1.500.000 |
| **Keuntungan Bersih** | **Rp 1.500.000 (100%)** | **Rp 1.375.110 (91,7%)** | **Rp 1.421.300 (94,8%)** |
