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
