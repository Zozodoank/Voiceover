// worker/routes/pricing.js - Harga tier kualitas (publik, tanpa login) agar UI bisa hidrasi
// label harga tanpa menanam angka atau nama model di HTML.
import { Hono } from 'hono';
import { loadTierPrices, tierList } from '../lib/pricing.js';

const router = new Hono();

router.get('/pricing', async (c) => {
    const prices = await loadTierPrices(c.env);
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ tiers: tierList(prices) });
});

export default router;
