// Per-marketplace Amazon prices via SerpAPI's Amazon engine.
// Requires SERPAPI_KEY. One search is spent per domain per refresh.
import { filterOutliers } from '../lib/offers.js';
import { safeUrl } from './serpapi.js';

export const DEFAULT_AMAZON_DOMAINS = ['amazon.com.be', 'amazon.nl', 'amazon.de'];

export const amazonStoreName = (domain) => `Amazon.${domain.slice('amazon.'.length)}`;

export function parseDomains(value) {
  const domains = String(value ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  for (const d of domains) {
    if (!/^amazon\.[a-z]{2,3}(\.[a-z]{2})?$/.test(d)) throw new Error(`Invalid Amazon domain "${d}"`);
  }
  return domains;
}

// Search results are ordered by relevance, so only the first few are considered,
// and anything far below the median of those (accessories) is ignored.
export function parseAmazonResults(json, domain, { top = 8, ratio = 0.5 } = {}) {
  const rows = (json.organic_results ?? [])
    .filter((r) => !r.sponsored && typeof r.extracted_price === 'number' && r.extracted_price > 0)
    .slice(0, top)
    .map((r) => ({ price: r.extracted_price, url: safeUrl(r.link), title: r.title }));
  const cheapest = filterOutliers(rows, ratio).sort((a, b) => a.price - b.price)[0];
  return cheapest ? { store: amazonStoreName(domain), ...cheapest } : null;
}

export function amazonProvider({ apiKey, domains = DEFAULT_AMAZON_DOMAINS, fetchImpl = fetch }) {
  return {
    name: 'amazon',
    demo: false,

    async fetchOffers(query) {
      const results = await Promise.allSettled(
        domains.map(async (domain) => {
          const params = new URLSearchParams({ engine: 'amazon', k: query, amazon_domain: domain, api_key: apiKey });
          const res = await fetchImpl(`https://serpapi.com/search.json?${params}`);
          if (!res.ok) throw new Error(`SerpAPI responded ${res.status}`);
          const json = await res.json();
          if (json.error) throw new Error(json.error);
          return parseAmazonResults(json, domain);
        }),
      );
      const offers = results.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
      offers.warnings = results
        .map((r, i) => (r.status === 'rejected' ? `${amazonStoreName(domains[i])}: ${r.reason.message}` : null))
        .filter(Boolean);
      if (!offers.length && offers.warnings.length === domains.length) throw new Error(offers.warnings[0]);
      return offers;
    },
  };
}
