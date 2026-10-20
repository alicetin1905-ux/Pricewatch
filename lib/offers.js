export function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Shopping searches mix in accessories and parts; with enough offers to judge,
// anything far below the median is almost certainly not the product itself.
export function filterOutliers(offers, ratio = 0.4) {
  if (offers.length < 3) return offers;
  const floor = median(offers.map((o) => o.price)) * ratio;
  return offers.filter((o) => o.price >= floor);
}

export function sortOffers(offers) {
  return [...offers].sort((a, b) => a.price - b.price);
}

export function bestOffer(offers) {
  return offers.length ? sortOffers(offers)[0] : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

export function summarize(product, sparkPoints = 30) {
  const history = product.history;
  const series = history
    .map((s) => ({ t: s.t, price: bestOffer(s.offers)?.price }))
    .filter((p) => p.price != null);
  const latest = history.at(-1);
  const offers = latest ? sortOffers(latest.offers) : [];
  const best = offers[0] ?? null;
  const prev = series.length > 1 ? series.at(-2).price : null;
  const prices = series.map((p) => p.price);
  const avg = offers.length ? offers.reduce((a, o) => a + o.price, 0) / offers.length : null;

  return {
    id: product.id,
    name: product.name,
    targetPrice: product.targetPrice ?? null,
    lastChecked: latest?.t ?? null,
    lastError: product.lastError ?? null,
    best,
    offers,
    change: best && prev != null ? round2(best.price - prev) : null,
    changePct: best && prev ? round2(((best.price - prev) / prev) * 100) : null,
    allTimeLow: prices.length ? Math.min(...prices) : null,
    allTimeHigh: prices.length ? Math.max(...prices) : null,
    averageOffer: avg == null ? null : round2(avg),
    savingsVsAverage: best && avg != null ? round2(avg - best.price) : null,
    atTarget: best != null && product.targetPrice != null && best.price <= product.targetPrice,
    spark: series.slice(-sparkPoints),
  };
}

export function historySeries(product) {
  return product.history
    .map((s) => ({ t: s.t, price: bestOffer(s.offers)?.price, store: bestOffer(s.offers)?.store }))
    .filter((p) => p.price != null);
}
