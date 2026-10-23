// worker/lib/db.js - Helper D1 untuk users/saldo (sumber kebenaran kredit, kuat-konsisten)

/** Daftar email superadmin dari env SUPERADMIN_EMAILS (pisahkan koma). */
export function superadminList(env) {
    return String(env.SUPERADMIN_EMAILS || 'jho.j80@gmail.com')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);
}

export function isSuperadminEmail(env, email) {
    return superadminList(env).includes(String(email || '').toLowerCase());
}

/**
 * Upsert user saat login; flag unlimited ditetapkan server-side dari daftar superadmin.
 * initialBalance HANYA dipakai saat baris baru dibuat (INSERT). On-conflict (login berikutnya)
 * TIDAK menyentuh balance, sehingga kredit berjalan user tidak berubah.
 */
export async function upsertUser(db, { sub, email, name, unlimited, initialBalance = 0 }) {
    const startBalance = Math.max(0, Number(initialBalance) || 0);
    await db.prepare(
        `INSERT INTO users (email, sub, name, balance, unlimited, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(email) DO UPDATE SET sub = excluded.sub, name = excluded.name, unlimited = excluded.unlimited`
    ).bind(email, sub, name, startBalance, unlimited ? 1 : 0).run();
    return getUser(db, email);
}

export async function getUser(db, email) {
    return await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
}

export async function addBalance(db, email, amount) {
    return await db.prepare('UPDATE users SET balance = balance + ? WHERE email = ?').bind(amount, email).run();
}

/** Potong saldo hanya jika cukup (atomik lewat predicate WHERE). Return true jika terpotong. */
export async function tryDeductBalance(db, email, amount) {
    const res = await db.prepare(
        'UPDATE users SET balance = balance - ?, total_gen = total_gen + 1 WHERE email = ? AND balance >= ? AND unlimited = 0'
    ).bind(amount, email, amount).run();
    const meta = res.meta || {};
    return (meta.changes || 0) > 0;
}

/** Tambah total generasi untuk superadmin (tidak menyentuh saldo). */
export async function countGeneration(db, email) {
    return await db.prepare('UPDATE users SET total_gen = total_gen + 1 WHERE email = ?').bind(email).run();
}

export async function listUsers(db) {
    const res = await db.prepare('SELECT email, name, balance, unlimited, total_gen, created_at FROM users ORDER BY created_at DESC LIMIT 500').all();
    return res.results || [];
}

export async function usageStats(db) {
    const row = await db.prepare(
        'SELECT COUNT(*) AS total_users, COALESCE(SUM(total_gen),0) AS total_generations, COALESCE(SUM(balance),0) AS total_balance FROM users'
    ).first();
    return {
        totalUsers: Number(row.total_users) || 0,
        totalGenerations: Number(row.total_generations) || 0,
        totalBalance: Number(row.total_balance) || 0,
    };
}
