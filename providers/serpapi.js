// Live prices from Google Shopping via SerpAPI (https://serpapi.com).
// Requires SERPAPI_KEY. Optional: SERPAPI_GL (country code, default "us").

const safeUrl = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

export function parseShoppingResults(json) {
  const results = json.shopping_results ?? [];
  const byStore = new Map();
  for (const r of results) {
    const price = r.extracted_price;
    if (typeof price !== 'number' || !(price > 0) || !r.source) continue;
    const existing = byStore.get(r.source);
    if (existing && existing.price <= price) continue;
    byStore.set(r.source, {
      store: r.source,
      price,
      url: safeUrl(r.product_link ?? r.link),
      title: r.title,
    });
  }
  return [...byStore.values()];
}

export function serpApiProvider({ apiKey, gl = 'us', fetchImpl = fetch }) {
  return {
    name: 'serpapi',
    demo: false,

    async fetchOffers(query) {
      const params = new URLSearchParams({
        engine: 'google_shopping',
        q: query,
        gl,
        hl: 'en',
        api_key: apiKey,
      });
      const res = await fetchImpl(`https://serpapi.com/search.json?${params}`);
      if (!res.ok) throw new Error(`SerpAPI responded ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`SerpAPI: ${json.error}`);
      return parseShoppingResults(json);
    },
  };
}
