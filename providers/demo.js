// Simulated prices so the dashboard is usable without any API key.
// Prices are a pure function of (query, time), so history backfills are stable.

const STORES = [
  ['Amazon.com.be', 1.03],
  ['Amazon.nl', 1.0],
  ['Amazon.de', 0.97],
  ['bol.com', 1.02],
  ['Coolblue', 1.06],
  ['MediaMarkt', 1.04],
  ['Fnac', 1.07],
];

function hash(str) {
  let h = 2166136261;
  for (const ch of str.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function offersAt(query, now) {
  const seed = hash(query);
  const base = 60 + (seed % 1100);
  const day = now / 86_400_000;
  const searchUrl = `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`;

  return STORES.filter((_, i) => (seed >> i) & 1 || i < 4).map(([store, factor], i) => {
    const phase = ((seed >>> (i * 3)) % 628) / 100;
    const drift = Math.sin(day / 9 + phase) * 0.06 + Math.sin(day / 2.3 + phase * 2) * 0.025;
    const sale = Math.sin(day / 17 + phase) > 0.93 ? -0.08 : 0;
    const price = Math.round(base * factor * (1 + drift + sale)) - 0.01;
    return { store, price, url: searchUrl };
  });
}

export const demoProvider = {
  name: 'demo',
  demo: true,

  async fetchOffers(query) {
    return offersAt(query, Date.now());
  },

  // 30 days of twice-daily snapshots, so a new product has a chart immediately.
  backfill(query, now = Date.now()) {
    const out = [];
    for (let h = 30 * 24; h > 0; h -= 12) {
      const t = now - h * 3_600_000;
      out.push({ t, offers: offersAt(query, t) });
    }
    return out;
  },
};
