import { demoProvider } from './demo.js';
import { serpApiProvider } from './serpapi.js';
import { amazonProvider, DEFAULT_AMAZON_DOMAINS, parseDomains } from './amazon.js';
import { bolProvider } from './bol.js';
import { combineProviders } from './combine.js';
import { meteredFetch } from '../lib/meter.js';

export function pickProvider(env = process.env, { meter } = {}) {
  const wanted = env.PROVIDER ?? (env.SERPAPI_KEY ? 'serpapi' : 'demo');
  if (wanted === 'demo') return demoProvider;
  if (wanted !== 'serpapi') throw new Error(`Unknown PROVIDER "${wanted}" (expected "demo" or "serpapi")`);
  if (!env.SERPAPI_KEY) throw new Error('PROVIDER=serpapi needs SERPAPI_KEY to be set');

  const apiKey = env.SERPAPI_KEY;
  const fetchImpl = meter ? meteredFetch(meter) : fetch;
  const domains = env.AMAZON_DOMAINS == null ? DEFAULT_AMAZON_DOMAINS : parseDomains(env.AMAZON_DOMAINS);
  const sources = [];
  if (env.GOOGLE_SHOPPING !== '0') sources.push(serpApiProvider({ apiKey, gl: env.SERPAPI_GL ?? 'be', fetchImpl }));
  if (domains.length) sources.push(amazonProvider({ apiKey, domains, fetchImpl }));
  if (env.BOL !== '0') sources.push(bolProvider({ apiKey, gl: env.BOL_GL ?? 'nl', fetchImpl }));
  if (!sources.length) throw new Error('Nothing to search: enable GOOGLE_SHOPPING, BOL or set AMAZON_DOMAINS');

  if (sources.length === 1) return sources[0];
  const label = { serpapi: 'Google Shopping', amazon: 'Amazon', 'bol.com': 'bol.com' };
  return combineProviders(sources, sources.map((p) => label[p.name]).join(' + '));
}
