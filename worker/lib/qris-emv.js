// worker/lib/qris-emv.js - Mesin payload QRIS EMVCo: parser TLV, CRC16-CCITT, dan konversi statis -> dinamis.
// Semua fungsi murni (tanpa state) kecuali inspectStaticPayload/resolveStaticPayload yang membaca KV/ENV.
// Catatan: JANGAN memakai string.replace() pada payload - literal seperti "010211" bisa muncul di dalam
// nilai tag lain (nama merchant, template), sehingga wajib lewat parser TLV.

export const QRIS_STATIC_KEY = 'qris_static';               // key KV: {payload, updatedAt, by}
export const QRIS_AMOUNT_TAG = '54';
export const QRIS_CRC_TAG = '63';

/** Error ber-kode agar pemanggil bisa membedakan jenis kegagalan payload. */
export class QrisError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'QrisError';
        this.code = code;
    }
}

/** CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF, tanpa refleksi, xorout 0) -> 4 hex HURUF BESAR. */
export function crc16ccitt(input) {
    const s = String(input == null ? '' : input);
    let crc = 0xFFFF;
    for (let i = 0; i < s.length; i++) {
        crc ^= (s.charCodeAt(i) & 0xFF) << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) !== 0
                ? ((crc << 1) ^ 0x1021) & 0xFFFF
                : (crc << 1) & 0xFFFF;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Buang karakter tak terlihat (zero-width) dan spasi baris di tepi payload hasil copy-paste.
 * Spasi DI DALAM nilai tag (mis. nama merchant "TOKO JAYA") tetap dipertahankan karena
 * panjang TLV dan CRC dihitung termasuk karakter tersebut.
 */
export function normalizePayload(payload) {
    return String(payload == null ? '' : payload)
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[\r\n\t]/g, '')
        .trim();
}

/**
 * Parse payload menjadi daftar {tag, value, raw}. Melempar QrisError('malformed_tlv')
 * bila ada potongan yang tidak lengkap atau panjangnya melebihi sisa string.
 */
export function parseTLV(payload) {
    const src = normalizePayload(payload);
    if (!src) throw new QrisError('empty', 'Payload QRIS kosong');
    const tags = [];
    let i = 0;
    while (i < src.length) {
        if (i + 4 > src.length) throw new QrisError('malformed_tlv', `TLV terpotong di offset ${i}`);
        const tag = src.slice(i, i + 2);
        const lenRaw = src.slice(i + 2, i + 4);
        if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenRaw)) {
            throw new QrisError('malformed_tlv', `Tag/panjang tidak valid di offset ${i}`);
        }
        const len = parseInt(lenRaw, 10);
        const start = i + 4;
        const end = start + len;
        if (end > src.length) throw new QrisError('malformed_tlv', `Nilai tag ${tag} melebihi panjang payload`);
        tags.push({ tag, value: src.slice(start, end), raw: src.slice(i, end) });
        i = end;
    }
    if (!tags.length) throw new QrisError('malformed_tlv', 'Tidak ada tag yang terbaca');
    return tags;
}

/** Bentuk satu potongan TLV: tag(2) + panjang(2) + value. */
export function buildTLV(tag, value) {
    const t = String(tag == null ? '' : tag);
    const v = String(value == null ? '' : value);
    if (!/^\d{2}$/.test(t)) throw new QrisError('bad_tag', `Tag tidak valid: ${t}`);
    if (v.length > 99) throw new QrisError('value_too_long', `Nilai tag ${t} melebihi 99 karakter`);
    return `${t}${String(v.length).padStart(2, '0')}${v}`;
}

/** Nilai sub-tag pertama yang cocok di dalam sebuah nilai TLV bersarang (mis. tag 26/51). */
function subTagValue(value, wanted) {
    try {
        for (const sub of parseTLV(value)) {
            if (sub.tag === wanted) return sub.value;
        }
    } catch (e) { /* nilai bukan TLV bersarang - abaikan */ }
    return null;
}

/**
 * Validasi payload QRIS statis: struktur TLV, tag wajib (00/58/63), dan checksum CRC16.
 * Mengembalikan objek status (tidak melempar) agar bisa dipakai langsung oleh dasbor admin.
 */
export function validateStaticQris(payload) {
    const src = normalizePayload(payload);
    if (!src) return { ok: false, reason: 'empty', error: 'Payload QRIS kosong' };
    if (src.length < 40) return { ok: false, reason: 'too_short', error: 'Payload terlalu pendek untuk QRIS' };
    if (!src.startsWith('0002')) return { ok: false, reason: 'bad_prefix', error: 'Payload harus diawali "000201"' };

    let tags;
    try {
        tags = parseTLV(src);
    } catch (e) {
        return { ok: false, reason: 'malformed_tlv', error: e.message || 'Struktur TLV tidak valid' };
    }

    const map = {};
    for (const t of tags) if (!(t.tag in map)) map[t.tag] = t.value;
    const merchantName = map['59'] || null;
    const merchantCity = map['60'] || null;
    const base = { merchantName, merchantCity, poi: map['01'] || null, hasAmount: QRIS_AMOUNT_TAG in map };

    if (!('00' in map)) return { ok: false, reason: 'missing_payload_format', error: 'Tag 00 (payload format indicator) tidak ada', ...base };
    if (!('58' in map)) return { ok: false, reason: 'missing_country', error: 'Tag 58 (kode negara) tidak ada', ...base };

    const last = tags[tags.length - 1];
    if (last.tag !== QRIS_CRC_TAG || last.value.length !== 4) {
        return { ok: false, reason: 'missing_crc', error: 'Tag 63 (CRC) tidak ada / tidak di akhir payload', ...base };
    }
    const expected = crc16ccitt(src.slice(0, -4));
    const actual = last.value.toUpperCase();
    if (expected !== actual) {
        return {
            ok: false,
            reason: 'bad_crc',
            error: `CRC tidak cocok (terbaca ${actual}, seharusnya ${expected})`,
            crcOk: false,
            ...base,
        };
    }

    // NMID/nomor merchant: sub-tag 02 pada tag 51 (domestik) atau tag 26 (acquirer).
    const nmid = subTagValue(map['51'] || '', '02') || subTagValue(map['26'] || '', '02') || null;
    return { ok: true, reason: null, error: null, crcOk: true, nmid, payload: src, ...base };
}

/**
 * Konversi payload statis -> dinamis: Tag 01 = '12', Tag 54 = nominal (terkunci), CRC dihitung ulang.
 * Melempar QrisError bila payload statis tidak valid atau nominal tidak wajar.
 */
export function buildDynamicQris(staticPayload, amount) {
    const check = validateStaticQris(staticPayload);
    if (!check.ok) throw new QrisError(check.reason || 'invalid_static', check.error || 'Payload QRIS statis tidak valid');

    // Nominal wajib bilangan bulat positif tanpa leading zero (QRIS Tag 54 = digit polos).
    const rawAmount = typeof amount === 'string' ? amount.trim() : amount;
    if (typeof rawAmount === 'string' && !/^[1-9]\d{0,12}$/.test(rawAmount)) {
        throw new QrisError('bad_amount', `Nominal tidak valid: ${amount}`);
    }
    const amountNumber = Number(rawAmount);
    if (!Number.isFinite(amountNumber) || !Number.isInteger(amountNumber) || amountNumber <= 0) {
        throw new QrisError('bad_amount', `Nominal tidak valid: ${amount}`);
    }
    const amtStr = String(amountNumber);
    if (!/^[1-9]\d{0,12}$/.test(amtStr)) {
        throw new QrisError('bad_amount', `Nominal tidak valid: ${amount}`);
    }

    // Buang CRC lama dan nominal lama; sisanya dipertahankan byte-per-byte dan tetap urut.
    const items = parseTLV(check.payload)
        .filter(t => t.tag !== QRIS_CRC_TAG && t.tag !== QRIS_AMOUNT_TAG)
        .map(t => ({ tag: t.tag, raw: t.raw }));

    const i01 = items.findIndex(x => x.tag === '01');
    const dynamic01 = { tag: '01', raw: buildTLV('01', '12') };
    if (i01 >= 0) {
        items[i01] = dynamic01;
    } else {
        const i00 = items.findIndex(x => x.tag === '00');
        items.splice(i00 >= 0 ? i00 + 1 : 0, 0, dynamic01);
    }

    const i58 = items.findIndex(x => x.tag === '58');
    items.splice(i58 >= 0 ? i58 : items.length, 0, { tag: QRIS_AMOUNT_TAG, raw: buildTLV(QRIS_AMOUNT_TAG, amtStr) });

    const body = items.map(x => x.raw).join('');
    // CRC dihitung atas seluruh string SAMPAI dengan tag "6304" (bukan hanya body).
    const withCrcTag = `${body}${QRIS_CRC_TAG}04`;
    const result = `${withCrcTag}${crc16ccitt(withCrcTag)}`;

    // Assertion pasca-build: lebih baik gagal keras daripada menyajikan QR yang nominalnya salah.
    const built = parseTLV(result);
    const last = built[built.length - 1];
    const values = {};
    for (const t of built) if (!(t.tag in values)) values[t.tag] = t.value;
    if (last.tag !== QRIS_CRC_TAG || last.value.toUpperCase() !== crc16ccitt(result.slice(0, -4))) {
        throw new QrisError('crc_mismatch', 'CRC hasil build tidak valid');
    }
    if (values[QRIS_AMOUNT_TAG] !== amtStr || values['01'] !== '12') {
        throw new QrisError('build_mismatch', 'Tag 01/54 hasil build tidak sesuai');
    }
    return result;
}

/** Sumber payload statis: KV 'qris_static' (prioritas) lalu env QRIS_STATIC_PAYLOAD (fallback). */
export async function inspectStaticPayload(env, kv) {
    let record = null;
    try {
        const raw = kv ? await kv.get(QRIS_STATIC_KEY) : null;
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.payload) record = parsed;
        }
    } catch (e) {
        console.error('QRIS static KV read failed:', e && e.message ? e.message : String(e));
    }
    if (record) {
        return {
            source: 'kv',
            payload: normalizePayload(record.payload),
            updatedAt: record.updatedAt || null,
            updatedBy: record.by || null,
            validation: validateStaticQris(record.payload),
        };
    }
    const envPayload = normalizePayload(env && env.QRIS_STATIC_PAYLOAD);
    if (envPayload) {
        return { source: 'env', payload: envPayload, updatedAt: null, updatedBy: null, validation: validateStaticQris(envPayload) };
    }
    return { source: null, payload: null, updatedAt: null, updatedBy: null, validation: null };
}

/**
 * Payload siap pakai untuk membuat QRIS dinamis. Bila payload tidak ada/tidak valid,
 * mengembalikan payload:null agar billing turun ke alur gambar statis lama (bukan QR yang salah).
 */
export async function resolveStaticPayload(env, kv) {
    const found = await inspectStaticPayload(env, kv);
    if (!found.payload) {
        return { payload: null, source: found.source, merchantName: null, merchantCity: null, nmid: null, reason: 'not_configured' };
    }
    if (!found.validation || !found.validation.ok) {
        console.error(`QRIS static payload (${found.source}) tidak valid: ${found.validation ? found.validation.error : 'unknown'}`);
        return { payload: null, source: 'invalid', merchantName: null, merchantCity: null, nmid: null, reason: found.validation ? found.validation.reason : 'invalid' };
    }
    return {
        payload: found.validation.payload,
        source: found.source,
        merchantName: found.validation.merchantName,
        merchantCity: found.validation.merchantCity,
        nmid: found.validation.nmid || null,
        reason: null,
    };
}

/** Tampilkan payload secara aman di dasbor admin (30 karakter awal + 6 terakhir). */
export function maskPayload(payload) {
    const s = normalizePayload(payload);
    if (!s) return '';
    if (s.length <= 40) return `${s.slice(0, 12)}...${s.slice(-4)}`;
    return `${s.slice(0, 30)}...${s.slice(-6)}`;
}
