// bol.com prices, found through Google Shopping (SerpAPI) rather than bol.com's own
// API, which needs a bol affiliate account. Costs one search per refresh.
import { median } from '../lib/offers.js';
import { safeUrl, searchGoogleShopping } from './serpapi.js';

export const BOL_STORE = 'bol.com';

const isBol = (source) => /^bol(\.com)?$/i.test(String(source ?? '').trim());

// The floor comes from every result for the query, so a bol.com listing for an
// accessory is ignored just like in the other sources.
export function parseBolResults(json, ratio = 0.5) {
  const rows = (json.shopping_results ?? []).filter((r) => typeof r.extracted_price === 'number' && r.extracted_price > 0);
  if (!rows.length) return null;
  const floor = median(rows.map((r) => r.extracted_price)) * ratio;
  const cheapest = rows
    .filter((r) => isBol(r.source) && r.extracted_price >= floor)
    .sort((a, b) => a.extracted_price - b.extracted_price)[0];
  return cheapest
    ? { store: BOL_STORE, price: cheapest.extracted_price, url: safeUrl(cheapest.product_link ?? cheapest.link), title: cheapest.title }
    : null;
}

export function bolProvider({ apiKey, gl = 'nl', fetchImpl = fetch }) {
  return {
    name: 'bol.com',
    demo: false,
    cost: 1,

    async fetchOffers(query) {
      const json = await searchGoogleShopping({ apiKey, query: `${query} bol.com`, gl, hl: 'nl', fetchImpl });
      const offer = parseBolResults(json);
      const offers = offer ? [offer] : [];
      if (!offer) offers.warnings = ['bol.com: no listing found in Google Shopping results'];
      return offers;
    },
  };
}
