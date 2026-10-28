-- schema.sql - Skema D1 vo-studio-db
-- Jalankan lokal: npx wrangler d1 execute vo-studio-db --local --file=./schema.sql
-- Jalankan remote: npx wrangler d1 execute vo-studio-db --remote --file=./schema.sql
CREATE TABLE IF NOT EXISTS users (
    email      TEXT PRIMARY KEY,
    sub        TEXT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    balance    INTEGER NOT NULL DEFAULT 0,
    unlimited  INTEGER NOT NULL DEFAULT 0,
    total_gen  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_sub ON users(sub);

-- Pengaturan ringan (harga per tier kualitas, dll). Nilai dibaca worker dengan fallback default.
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ledger pembayaran QRIS: audit + penjaga idempotensi webhook MacroDroid.
-- order_id UNIQUE membuat kiriman notifikasi ganda tidak pernah mengkredit saldo dua kali:
-- INSERT + UPDATE saldo dijalankan dalam satu batch (transaksi) di worker.
CREATE TABLE IF NOT EXISTS payments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id       TEXT    NOT NULL UNIQUE,
    email          TEXT    NOT NULL,
    base_amount    INTEGER NOT NULL,
    total_amount   INTEGER NOT NULL,
    matched_amount INTEGER,
    match_type     TEXT    NOT NULL,       -- 'exact' | 'code' | 'scan'
    raw_text       TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_email ON payments(email);
