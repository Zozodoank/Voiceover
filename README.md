# VO Affiliate Studio (Cloudflare Worker + Multi-Tenant OAuth)

Aplikasi pembuatan Voice Over affiliate berbasis AI dengan **landing page + login Google OAuth**,
saldo credit per-user yang ditegakkan di server (Cloudflare D1), pembayaran QRIS yang diverifikasi
otomatis lewat MacroDroid, dan analisa video nyata (ekstrak frame di browser → Gemini / AIVene).

Backend berjalan sebagai **Cloudflare Worker (Hono)** — satu kodebase untuk dev (`npx wrangler dev`)
maupun produksi (`npx wrangler deploy`). Tidak ada lagi server Express.

## Arsitektur Singkat
```
VO-Affiliate/
├── worker/                   # BACKEND Cloudflare Worker (Hono, ESM)
│   ├── index.js              # Mount route /api/* + serve public/ via binding ASSETS
│   ├── lib/
│   │   ├── auth.js           # Verifikasi ID token Google (jose/JWKS) + cookie sesi HMAC
│   │   ├── middleware.js     # requireAuth / requireSuperadmin / helper cookie
│   │   ├── db.js             # Helper D1: upsert user, saldo atomic, statistik
│   │   ├── ai.js             # Gemini (utama) + AIVene qwen3.8-flash (fallback) + normalisasi JSON
│   │   ├── qris.js           # Order QRIS di KV (TTL 30 mnt) + matchOrder (exact → kode 2 digit → scan)
│   │   ├── qris-emv.js       # Parser TLV EMVCo + CRC16-CCITT: payload statis → QRIS dinamis
│   │   └── qris-svg.js       # Render payload QRIS menjadi SVG (qrcode-generator, tanpa DOM)
│   └── routes/
│       ├── auth.js           # POST /api/auth/session, GET /api/auth/config, GET /api/me, POST /api/auth/logout
│       ├── analyze.js        # POST /api/analyze (auth + gerbang credit + potong saldo setelah AI sukses)
│       ├── payment.js        # POST /api/payment/create-qris, GET /api/payment/qr/:orderId, GET /api/payment/status/:orderId
│       ├── webhook.js        # POST /api/webhook/macrodroid (x-macrodroid-key → ledger `payments` + credit D1, idempoten)
│       ├── admin.js          # /api/admin/stats|users|adjust-credit|qris-image|qris-static|payments (superadmin only)
│       └── download.js       # GET /api/download/files|file/:path (whitelist, dibaca dari Assets)
├── public/                   # FRONTEND + Static Assets Worker
│   ├── index.html            # LANDING (hero, fitur, harga, tombol "Masuk dengan Google" GIS)
│   ├── app.html              # Studio (ex index.html lama) — butuh cookie sesi
│   ├── admin.html            # Dasbor superadmin (jho.j80@gmail.com)
│   ├── css/styles.css
│   └── js/                   # state, tenant, api, ui, history, auth, payment, frames, studio, playback, deploy, app
├── wrangler.toml             # name, main, assets, KV ORDERS, D1 VO_DB, [vars]
├── schema.sql                # CREATE TABLE users (saldo) + payments (ledger/idempotensi pembayaran QRIS)
├── .dev.vars.example         # Template secret lokal (salin jadi .dev.vars)
├── start_app.bat             # Peluncur dev: npx wrangler dev → http://localhost:8787
└── qris_megakomindo_verifier.macro
```

## Menjalankan Lokal (Dev)
1. Pastikan [Node.js LTS](https://nodejs.org) terpasang, lalu `npm install`.
2. Buat D1 & KV **local** cukup dengan simulasi `wrangler dev`; untuk data nyata:
   ```
   npx wrangler d1 create vo-studio-db        # salin database_id → wrangler.toml
   npx wrangler kv namespace create ORDERS    # salin id          → wrangler.toml
   npx wrangler d1 execute vo-studio-db --local --file=./schema.sql
   ```
   > `wrangler dev` memakai simulasi lokal (`.wrangler/`), sehingga KV/D1 lokal otomatis dibuat —
   > namun ganti ID placeholder di `wrangler.toml` sebelum `wrangler deploy`.
3. Salin `.dev.vars.example` → `.dev.vars`, isi `GEMINI_API_KEY`, `AIVENE_API_KEY`,
   `SESSION_SECRET`, `MACRODROID_SECRET_KEY`.
4. Klik 2x `start_app.bat` (atau `npx wrangler dev`) → buka `http://localhost:8787`.

## Setup Google OAuth (Google Identity Services)
1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → **Create Credentials → OAuth client ID** → tipe **Web application** (tanpa client secret — GIS memakai ID token implicit).
2. **Authorized JavaScript origins** (wajib semua tempat app dibuka):
   - `http://localhost:8787` (dev worker)
   - `https://<subdomain>.workers.dev` (produksi)
   - domain kustom Anda (opsional)
3. *Redirect URI tidak diperlukan* (tidak ada code-flow).
4. Salin **Client ID** ke:
   - dev: `[vars] GOOGLE_CLIENT_ID` di `wrangler.toml`, lalu gunakan client ID `http://localhost:8787` saat uji GIS lokal;
   - produksi: isi di `wrangler.toml` sebelum `wrangler deploy` (atau `npx wrangler secret put` tidak perlu — ini bukan rahasia).
5. Login di landing memanggil `POST /api/auth/session`; Worker memverifikasi token via JWKS Google
   dan men-set cookie HttpOnly `vo_session` (30 hari).

## Setup Produksi (Cloudflare Free Tier)
```
npm login  (opsional) ; npx wrangler login
npx wrangler d1 create vo-studio-db          # → database_id ke wrangler.toml
npx wrangler kv namespace create ORDERS      # → id          ke wrangler.toml
npx wrangler d1 execute vo-studio-db --remote --file=./schema.sql
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put AIVENE_API_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put MACRODROID_SECRET_KEY
npx wrangler deploy
```
Superadmin ditentukan oleh `[vars] SUPERADMIN_EMAILS` (default `jho.j80@gmail.com`, pisahkan beberapa
email dengan koma). Akun tersebut mendapat saldo **∞ tanpa batas** (tidak pernah didebit) dan akses
`/admin.html`.

## Analisa Video (Bagaimana Bekerja)
- Browser mengekstrak **1 frame/detik, maks 6 frame, JPEG ≤320px (±1 MB total)** via `<video>`+canvas
  (`public/js/frames.js`) — **tanpa ffmpeg.wasm**, sesuai prinsip pemrosesan berat di sisi user.
  Setiap frame membawa **detik asalnya** (`{t, dataUrl}`) dan detik itu ikut dikirim ke server.
- `POST /api/analyze` → **Gemini flash (free tier)** sebagai model utama; saat 429/5xx/timeout 20s
  otomatis **fallback ke AIVene `qwen3.8-flash`** (±Rp 50 per analisa).
- Keluaran dinormalisasi ke JSON: `{research, scenes:[{start,end,emotion,text}], caption, hashtags}`.
- **Credit ditegakkan server-side (D1)**: debit cuma terjadi setelah AI sukses; dua-duanya gagal →
  HTTP 502 dan saldo tidak berubah. Harga: Rp 1.200 / 1.500 / 1.800 sesuai model di UI.
- Batasan: frame tidak memuat audio — prompt meminta model membaca teks on-screen.
  (Opsional fase berikutnya: kirim klip audio sebagai `inlineData audio/mp4`.)

## Sinkronisasi VO ↔ Visual

Voice over **mengikuti timeline video**, bukan sebaliknya. Satu aturan dipakai untuk pratinjau, burn-in
subtitle, ekspor WebM, dan berkas `.SRT` (`planTimeline()` di `public/js/audio-engine.js`).

1. **Jam utama = video.** `video.duration` dibaca dari `#mainVideo`; video diputar 1x dari detik 0, tidak
di-loop lagi. Bila `currentTime` video melenceng > 0,15 dtk (pratinjau) / 0,2 dtk (ekspor), posisinya
dikoreksi — jadi visual tidak pernah mengulang di tengah kalimat.
2. **Timestamp frame nyata.** `extractFrames()` mengembalikan `{t, dataUrl}`; `t` ikut dikirim ke
`POST /api/analyze` sebagai `frameTimes`. Tanpa ini model diberi tahu "frame N = detik N" padahal sampelnya
berjarak `duration / jumlahFrame`.
3. **Batas adegan divalidasi server** (`normalizeResult()` di `worker/lib/ai.js`): kontigu (`start` =
`end` adegan sebelumnya), di-*snap* ke detik frame terdekat (±0,75 dtk), adegan < 1,2 dtk digabung, dan
adegan terakhir ditutup tepat di durasi video.
4. **Anggaran kata.** Prompt memuat jendela antar frame beserta batas katanya (±**2,6 kata/detik**),
sehingga kalimat VO muat di adegannya dan CTA tidak perlu dipotong.
5. **Tempo terbatas.** Kalau audio tetap lebih panjang dari jendelanya, adegan itu dipercepat maksimal
**1,18x** (`SCENE_MAX_TEMPO`); bila lebih pendek, sisanya jadi jeda. Ekor adegan tidak pernah menimpa
adegan berikutnya (`start` minimal = akhir adegan sebelumnya + 0,12 dtk).
6. **Fallback data lama.** Proyek riwayat tanpa `start/end` tetap diputar berurutan seperti sebelumnya,
sementara proyek baru menyimpan `videoDuration` dan mengingatkan bila video yang dimuat berbeda.
7. **Kontrol terkait.** Toggle "Tampilkan Subtitle Otomatis" mematikan overlay sekaligus burn-in (`.SRT`
tetap bisa diunduh), label durasi menampilkan posisi/total, dan badge segmen diisi jumlah adegan nyata
setelah generate. Video lebih dari **30 detik** ditolak saat upload.
8. **Audio basi dibatalkan.** Mengganti video, memuat proyek riwayat, atau membuat naskah baru memanggil
`invalidateSceneAudios()`: prerender TTS yang masih berjalan dihentikan (`_prerenderToken`) supaya
`sceneAudios` tidak terisi sebagian audio milik timeline lama - tanpa ini ekspor bisa gagal dengan
pesan "suara adegan N gagal dibuat".

Uji terkait:
```
node .wrangler/test-analysis-timeline.mjs   # prompt frameTimes + anggaran kata + normalisasi kontigu (tanpa server)
node .wrangler/test-analyze-validation.mjs  # validasi POST /api/analyze di edge (butuh wrangler dev, tanpa kuota AI)
node .wrangler/verify-vo-visual-sync.mjs    # timeline berjangkar visual + tempo + total = durasi video
                                           # + pembatalan prerender basi (Chrome headless)
node .wrangler/verify-subtitle-sync.mjs     # subtitle mengikuti jendela adegan, termasuk jalur fallback
node .wrangler/verify-srt-unchanged.mjs     # format .SRT tetap, jalur berurutan maupun berjangkar
node .wrangler/verify-vo-visual-app.mjs     # end-to-end browser: upload -> frameTimes -> putar -> ekspor WebM
                                           # butuh `npx wrangler dev`; tambah --headful agar ekspor WebM
                                           # benar-benar terekam (encoder headless sering 0 byte)
```

## QRIS + MacroDroid
- Order disimpan di **KV `ORDERS`** (TTL 1800 s / `QRIS_ORDER_TTL_SECONDS`) terikat email user; kode unik
  2 digit dipertahankan (nominal = base + kode, dicek mod-100).
- Frontend polling `GET /api/payment/status/:orderId` tiap 5 detik — tidak ada lagi state in-memory.
- **Ubah URL webhook di file macro** `qris_megakomindo_verifier.macro` **hanya saat setup awal** (atau bila URL
  Worker berubah) — setelah macro menunjuk ke URL produksi, alur QRIS dinamis maupun alur dua langkah tidak
  memerlukan perubahan macro apa pun:
  - dev: `http://<IP-lokal-anda>:8787/api/webhook/macrodroid`
  - produksi: `https://<worker-url>/api/webhook/macrodroid`
  - Header `x-macrodroid-key` harus sama dengan secret `MACRODROID_SECRET_KEY`.
- Saat webhook cocok, Worker menulis baris ledger ke tabel D1 `payments` **dan** menambah saldo dalam satu
  batch transaksional (`paid:true` di KV). Notifikasi ganda dibalas `already_credited` tanpa kredit ulang.
- Ingin nominal terisi otomatis di aplikasi pembayar? Lihat bagian **QRIS Dinamis** di bawah.

## QRIS Dinamis (tanpa payment gateway)

Selain mode lama (satu gambar QRIS global + user mengetik kode 2 digit), Worker bisa membuat **QRIS dinamis
per order**: nominal `totalAmount` (base + kode verifikasi 2 digit) sudah **terkunci di dalam QR**, sehingga
aplikasi pembayar yang dipakai — di sini cukup **InterActive QRIS** (`com.interactive.qrisid`), aplikasi yang
sama dengan sumber notifikasi — mengisi sendiri nominalnya dan user tidak sempat salah bayar.

### Alur bayar di modal (dua langkah)
1. User membuka modal → yang tampil hanya **kotak placeholder** ("QRIS muncul setelah kamu menekan Bayar");
   gambar QRIS **belum** diunduh dan Total Transfer masih `—`.
2. User mengisi nominal deposit (boleh dari preset studio: 1.200 / 1.500 / 1.800) lalu menekan **Bayar**.
   Satu request `POST /api/payment/create-qris`; tombol dikunci ("Menyiapkan QRIS...") agar order tidak dobel.
3. Order dibuat → QRIS dinamis tampil (nominal = base + 2 digit kode), badge + hitung mundur 30 menit,
   total + tombol salin/unduh aktif, polling status berjalan. Label tombol utama berubah menjadi **Buat Ulang**.
4. Nominal wajib **kelipatan Rp 100** (input `step=100`): klien membulatkan **ke bawah** disertai hint (tidak
   pernah menagih lebih dari yang diketik), server menolak `baseAmount % 100 !== 0` dengan 400 +
   `code: amount_not_multiple_of_100`. Ini yang menjamin 2 digit kode benar-benar berada di akhir nominal,
   sehingga pass `exact` di `matchOrder` (dan indeks `digit:<kode>` di KV) selalu bekerja.
5. Bila nominal diubah setelah QR tampil → tombol diberi aksen + hint "tekan Buat Ulang"; QR lama tetap valid
   sampai TTL habis (kredit tetap masuk ke user yang sama).
6. Tanpa payload statis (saklar fitur mati) → setelah Bayar yang tampil adalah QRIS statis + kode 2 digit
   manual, persis alur lama.

### Cara kerja (EMVCo MPMS TLV)
Payload QRIS adalah rangkaian `tag(2 digit) + panjang(2 digit) + value`:

| Tag | Isi | Perlakuan |
|---|---|---|
| `00` | versi payload (`01`) | dibiarkan |
| `01` | tipe POI: `11` statis / `12` dinamis | **dipaksa `12`** |
| `54` | nominal transaksi | **disisipkan/ditimpa** tepat sebelum Tag `58` |
| `58` / `59` / `60` | negara / nama merchant / kota | dibiarkan (dipakai untuk verifikasi di admin) |
| `63` | CRC16-CCITT-FALSE (`6304XXXX`) | **dihitung ulang** setelah perubahan |

`worker/lib/qris-emv.js` mem-parse TLV secara nyata (bukan `.replace()` pada string) sehingga aman ketika
literal `010211` muncul di dalam nama merchant; CRC16-CCITT-FALSE (poly `0x1021`, init `0xFFFF`, tanpa
refleksi) dihitung atas seluruh payload hingga awalan `6304`, lalu hasil build diverifikasi ulang
(`tag01 = '12'`, `tag54 = nominal`, CRC valid). Bila tidak konsisten, build gagal dan order tetap dibuat
**tanpa** QR dinamis (kembali ke alur lama) — tidak pernah menampilkan QR setengah benar.

`worker/lib/qris-svg.js` merender payload menjadi **SVG di server** (`qrcode-generator`, EC level `M`,
satu `<path>` per modul) sehingga tidak ada library QR di browser, payload merchant tidak dikirim ke API
pihak ketiga, dan hasilnya bisa langsung dipakai `<img>` maupun diunduh (PDF/cetak).

### Mengatur payload statis merchant
1. Ambil string payload dari QRIS statis merchant: scan `QRS.jpg` dengan Google Lens / decoder QR apa pun,
salin teksnya — diawali `000201010211...` dan diakhiri `6304XXXX`.
2. Buka `admin.html` → section **QRIS Dinamis (Payload Statis Merchant)** → tempel → **Validasi & Simpan**.
   Validasi menolak TLV rusak (`malformed_tlv`), CRC salah (`bad_crc`), Tag `58` (kode negara) hilang.
   Panel menampilkan sumber (`KV`/`env`), nama merchant + kota, NMID, status CRC, dan payload yang di-mask.
3. Klik **Pratinjau Rp 1.000** lalu **scan dari aplikasi InterActive QRIS** untuk memastikan nominal
terisi otomatis + terkunci **dan** nama merchant benar — lakukan ini **sebelum** mengaktifkan untuk user.
4. Alternatif tanpa dasbor: `npx wrangler secret put QRIS_STATIC_PAYLOAD` (atau `QRIS_STATIC_PAYLOAD=` di
`.dev.vars`). Nilai di KV selalu diutamakan; env hanya fallback.

### Saklar fitur & rollback
Keberadaan key KV `qris_static` **adalah** saklar fiturnya. Tombol **Hapus** (atau
`DELETE /api/admin/qris-static`) langsung mengembalikan billing ke alur lama: gambar QRIS statis +
input kode 2 digit manual. Tabel `payments` dan webhook tetap bekerja pada kedua mode.

### Endpoint baru
| Endpoint | Fungsi |
|---|---|
| `GET /api/payment/qr/:orderId?s=<qrToken>` | SVG QRIS dinamis per order (`Cache-Control: no-store`, CSP ketat). Akses lewat token 16 hex di `qrUrl` **atau** cookie sesi pemilik order; selain itu 403. |
| `GET /api/admin/qris-static` | Status payload (ter-mask, payload penuh tidak pernah dikirim) |
| `POST /api/admin/qris-static` | Validasi + simpan payload ke KV |
| `DELETE /api/admin/qris-static` | Hapus payload → fallback alur lama |
| `GET /api/admin/qris-static/preview?amount=` | SVG pratinjau nominal bebas (1 – 1.000.000) |
| `GET /api/admin/payments?limit=` | Audit/rekonsiliasi ledger pembayaran |

`POST /api/payment/create-qris` dan `GET /api/payment/status/:orderId` tidak berubah kontraknya — hanya
menambah field `qrUrl`, `qrToken`, `qrPayload`, `expiresAt`, `merchantName`, `qrPayloadAvailable`.

### Settlement & idempotensi
1. User scan QR dinamis dari **InterActive QRIS** → bayar nominal terkunci → notifikasi InterActive QRIS di HP
   merchant masuk dan diteruskan macro (satu aplikasi yang sama, tanpa wallet tambahan).
2. MacroDroid meneruskan notifikasi apa adanya: `POST /api/webhook/macrodroid` dengan header
`x-macrodroid-key` **dan** body `{"key":"...","notification_text":"{not_title} {notification} {not_text_big}"}`.
Field `amount`/`timestamp` **tidak wajib** — parser hanya butuh teks notifikasi.
3. Worker mengekstrak kandidat nominal berprioritas: `body.amount` (opsional) → pola `Rp`/`IDR` dengan titik
**maupun koma** (`Rp50.037,00`, `Rp50,037`, `50.037,-`) → fallback deret `\d{3,9}`. Kandidat di bawah
Rp 1.000 dibuang agar angka pendek seperti "Kode 37" tidak pernah dianggap total transfer. `matchOrder`
mencocokkan **exact `totalAmount`** lebih dulu, lalu kode 2 digit (`amt % 100`), baru scan legacy seluruh order;
tingkat kecocokan dicatat sebagai `match_type` (`exact`/`code`/`scan`).
4. `INSERT INTO payments (order_id UNIQUE, ...)` + `UPDATE users SET balance = balance + ?` dijalankan dalam
satu `db.batch()` transaksional. Kiriman ganda/replay dibalas `{status:'already_credited'}` (HTTP 200)
tanpa kredit ulang; nominal yang sudah tercatat di ledger (7 hari) juga tidak dipakai untuk order baru.
5. MacroDroid **tidak pernah** menerima 4xx (kecuali kunci salah) agar tidak retry tanpa henti;
`no_matching_order` tetap 200 dan bisa diaudit lewat `GET /api/admin/payments`.

Kode unik 2 digit **tetap dipakai** karena nominal deposit user sering bulat dan sama (Rp 50.000, Rp 100.000);
kode itu ikut terkunci di dalam QR sehingga tidak menambah usaha bagi user, tetapi membuat tiap order unik.

### Kontrak MacroDroid (tidak perlu diubah)

Macro yang sudah terpasang di HP merchant — `qris_megakomindo_verifier.macro` — **tidak perlu diubah** saat
fitur QRIS dinamis maupun alur dua langkah ini dipakai. Macro hanya meneruskan notifikasi aplikasi
**InterActive QRIS** (`com.interactive.qrisid`), dan server yang menyesuaikan diri:

| Elemen macro | Nilai terpasang | Penanganan di Worker |
|---|---|---|
| Trigger | Notifikasi dari InterActive QRIS, `m_supressMultiples: true` | di luar kendali server (tidak diubah) |
| URL | `POST https://voiceover.megakomindo.workers.dev/api/webhook/macrodroid` | path tetap, mendukung `body.key` sebagai fallback `x-macrodroid-key` |
| Body | `{"key":"<secret>","notification_text":"{not_title} {notification} {not_text_big}"}` | parser membaca `notification_text` (atau `text`/`message`); `amount` opsional |
| Nominal di teks | format bebas: `Rp 50.037`, `Rp50.037,00`, `Rp50,037`, `IDR 50.037,-` | dinormalisasi ke digit utuh sebelum dicocokkan |

Karena perubahan hanya terjadi di server, **jangan** menambah filter teks atau field baru di macro. Satu-satunya
variabel yang bisa memutus integrasi adalah `MACRODROID_SECRET_KEY` (`.dev.vars`/`wrangler secret`) yang tidak
sama dengan `x-macrodroid-key` di macro.

### Perintah terkait
```
npm run db:migrate                 # schema.sql (users + payments) ke D1 lokal
npm run db:migrate:remote          # idem untuk D1 produksi
node .wrangler/test-qris-emv.mjs   # unit test parser TLV + CRC (tanpa server)
node .wrangler/test-qris-match.mjs # unit test parser notifikasi (format titik/koma, bentuk body macro)
node .wrangler/e2e-qris.mjs        # e2e API (butuh wrangler dev; default port 8788)
node .wrangler/e2e-qris-ui.mjs     # e2e UI puppeteer (modal billing + dasbor admin)
# kedua e2e menerima override alamat server lewat env E2E_BASE, mis. E2E_BASE=http://127.0.0.1:8790
```

## Multi-Tenant localStorage
- Riwayat & preferensi disimpan dengan key bernamespace `…:<sub>` per akun Google (`public/js/tenant.js`).
- Data lama (sebelum multi-tenant) dimigrasikan sekali-jalan dengan penanda `__migrated__` (idempoten).
- Saldo di header hanya **cerminan UI** dari `GET /api/me` / respons `/api/analyze` — sumber kebenaran D1.

## Keamanan
- Hanya `public/` yang bisa diakses langsung; `.env`, `.dev.vars`, `worker/` tidak pernah disajikan
  (`curl /.env` → 404). Route unduhan memakai whitelist eksplisit via `env.ASSETS.fetch`.
- Flag `unlimited` & saldo **selalu** dihitung server-side — tidak pernah dipercaya dari klien.
- Cookie sesi HttpOnly + SameSite=Lax (+Secure saat https); secret di `.dev.vars`/`wrangler secret`.
- `.dev.vars` dan `.wrangler/` sudah termasuk `.gitignore` — jangan pernah commit API key.

## Pusat Unduh
Tombol "Unduh File Lengkap" mengambil file proyek dari whitelist yang dibaca Worker lewat
**Assets binding** (sumber asli, bukan salinan tertanam di HTML), lalu mengemas ZIP via JSZip di browser.

## Catatan Migrasi
- Server Express lama (`server.js`, `src/`) telah dihapus — seluruh endpoint dipertahankan path-nya
  (`/api/payment/*`, `/api/webhook/macrodroid`, `/api/download/*`) sehingga tidak ada perubahan MacroDroid selain URL.
- `ENV_TEMPLATE.env` tinggal sebagai referensi nama variabel; konfigurasi nyata memakai
  `.dev.vars` (dev) + `wrangler secret`/`[vars]` (produksi).
