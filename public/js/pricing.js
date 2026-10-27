// public/js/pricing.js - Hidrasi harga tier kualitas dari /api/pricing (sumber: pengaturan D1 admin).
// Classic script: memakai global tierPricing (state.js). Nama model TTS tidak pernah dikirim ke UI.

/** Format Rupiah untuk badge harga tier. */
function formatTierPrice(n) {
    return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
}

/**
 * Muat harga tier dari server lalu tempel ke radio (data-price) + badge harga + label.
 * Gagal jaringan tidak fatal: nilai statis di app.html tetap dipakai.
 */
async function loadTierPricing() {
    let tiers = [];
    try {
        const res = await fetch('/api/pricing', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        tiers = (data && data.tiers) || [];
    } catch (e) {
        return;
    }
    tiers.forEach((t) => {
        if (!t || !t.id) return;
        const price = Number(t.price);
        if (!Number.isFinite(price) || price < 0) return;
        tierPricing[t.id] = price;

        const radio = document.querySelector('input[name="ttsModel"][value="' + t.id + '"]');
        if (radio) radio.setAttribute('data-price', String(price));

        const tag = document.getElementById('priceTag-' + t.id);
        if (tag) tag.textContent = formatTierPrice(price);

        if (radio && t.label) {
            const label = radio.parentElement.querySelector('.text-xs.font-bold');
            if (label) label.textContent = t.label;
        }
    });
}

/** Harga satu tier dari cache lokal; fallback ke atribut data-price radio. */
function priceForTier(tier) {
    if (tierPricing[tier] != null) return tierPricing[tier];
    const radio = document.querySelector('input[name="ttsModel"][value="' + tier + '"]');
    const n = radio ? parseInt(radio.getAttribute('data-price'), 10) : NaN;
    return Number.isFinite(n) ? n : 0;
}
