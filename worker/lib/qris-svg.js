// worker/lib/qris-svg.js - Render payload QRIS menjadi string SVG (tanpa DOM/canvas, aman di workerd).
import qrcode from 'qrcode-generator';

/**
 * Bangun SVG QR dari teks payload.
 * - EC level 'M' (konvensi QRIS), versi otomatis (typeNumber 0).
 * - Modul digambar manual lewat getModuleCount()/isDark() agar format stabil antar versi paket.
 * Melempar Error ber-code 'empty_payload' / 'qr_capacity' bila tidak bisa dirender.
 */
export function qrSvg(text, opts) {
    const o = opts || {};
    const payload = String(text == null ? '' : text);
    if (!payload) {
        const err = new Error('Payload QR kosong');
        err.code = 'empty_payload';
        throw err;
    }
    const margin = Number.isFinite(Number(o.margin)) ? Math.max(0, Math.floor(Number(o.margin))) : 4;
    const size = Number.isFinite(Number(o.size)) ? Math.max(64, Math.floor(Number(o.size))) : 320;
    const darkColor = o.dark || '#000000';
    const lightColor = o.light || '#ffffff';

    let qr;
    try {
        qr = qrcode(0, 'M');
        qr.addData(payload);
        qr.make();
    } catch (e) {
        const err = new Error('Payload melebihi kapasitas QR: ' + (e && e.message ? e.message : String(e)));
        err.code = 'qr_capacity';
        throw err;
    }

    const count = qr.getModuleCount();
    const total = count + margin * 2;
    const modules = [];
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (!qr.isDark(row, col)) continue;
            modules.push(`M${col + margin} ${row + margin}h1v1h-1z`);
        }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '"'
        + ' viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges" role="img" aria-label="QRIS">'
        + '<rect width="' + total + '" height="' + total + '" fill="' + lightColor + '"/>'
        + '<path d="' + modules.join('') + '" fill="' + darkColor + '"/>'
        + '</svg>';
}
