import test from 'node:test';
import assert from 'node:assert/strict';
import { amazonProvider, parseAmazonResults, parseDomains } from '../providers/amazon.js';
import { combineProviders } from '../providers/combine.js';
import { pickProvider } from '../providers/index.js';
import { storeSeries } from '../lib/offers.js';

test('parseAmazonResults skips sponsored rows and accessory-priced rows, then takes the cheapest', () => {
  const json = {
    organic_results: [
      { title: 'Sponsored deal', extracted_price: 10, sponsored: true, link: 'https://www.amazon.de/dp/S' },
      { title: 'Headphones', extracted_price: 329, link: 'https://www.amazon.de/dp/A' },
      { title: 'Headphones (other colour)', extracted_price: 305, link: 'https://www.amazon.de/dp/B' },
      { title: 'Headphones (refurb)', extracted_price: 340, link: 'https://www.amazon.de/dp/C' },
      { title: 'Ear pads', extracted_price: 14, link: 'https://www.amazon.de/dp/D' },
      { title: 'No price' },
    ],
  };
  const offer = parseAmazonResults(json, 'amazon.de');
  assert.equal(offer.store, 'Amazon.de');
  assert.equal(offer.price, 305);
  assert.equal(offer.url, 'https://www.amazon.de/dp/B');
  assert.equal(parseAmazonResults({}, 'amazon.nl'), null);
});

test('store names are derived from the domain', () => {
  const names = parseDomains('amazon.com.be, AMAZON.NL ,amazon.de');
  assert.deepEqual(names, ['amazon.com.be', 'amazon.nl', 'amazon.de']);
  assert.throws(() => parseDomains('evil.example.com'), /Invalid Amazon domain/);
  assert.deepEqual(parseDomains(''), []);
});

test('amazonProvider queries each marketplace and reports the ones that failed', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    seen.push([u.searchParams.get('engine'), u.searchParams.get('amazon_domain'), u.searchParams.get('k')]);
    if (u.searchParams.get('amazon_domain') === 'amazon.nl') return { ok: false, status: 429 };
    const price = u.searchParams.get('amazon_domain') === 'amazon.de' ? 99 : 120;
    return { ok: true, json: async () => ({ organic_results: [{ title: 't', extracted_price: price }] }) };
  };
  const provider = amazonProvider({ apiKey: 'k', fetchImpl });
  const offers = await provider.fetchOffers('sony xm5');
  assert.deepEqual(offers.map((o) => [o.store, o.price]), [['Amazon.com.be', 120], ['Amazon.de', 99]]);
  assert.deepEqual(offers.warnings, ['Amazon.nl: SerpAPI responded 429']);
  assert.deepEqual(seen.map((s) => s[0]), ['amazon', 'amazon', 'amazon']);
  assert.ok(seen.every((s) => s[2] === 'sony xm5'));
});

test('amazonProvider throws when every marketplace fails', async () => {
  const provider = amazonProvider({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(provider.fetchOffers('x'), /500/);
});

test('combineProviders merges sources, keeps the cheapest duplicate store and survives one failure', async () => {
  const a = { name: 'a', fetchOffers: async () => [{ store: 'Amazon.de', price: 110 }, { store: 'bol.com', price: 100 }] };
  const b = { name: 'b', fetchOffers: async () => [{ store: 'amazon.de', price: 99 }] };
  const c = { name: 'c', fetchOffers: async () => { throw new Error('down'); } };
  const offers = await combineProviders([a, b, c], 'combo').fetchOffers('q');
  assert.deepEqual(offers.map((o) => [o.store, o.price]).sort(), [['amazon.de', 99], ['bol.com', 100]]);
  assert.deepEqual(offers.warnings, ['c: down']);
  await assert.rejects(combineProviders([c], 'x').fetchOffers('q'), /down/);
});

test('pickProvider enables the three Amazon marketplaces by default with a key', () => {
  assert.equal(pickProvider({}).demo, true);
  assert.equal(pickProvider({ SERPAPI_KEY: 'k' }).name, 'Google Shopping + Amazon');
  assert.equal(pickProvider({ SERPAPI_KEY: 'k', AMAZON_DOMAINS: '' }).name, 'serpapi');
  assert.equal(pickProvider({ SERPAPI_KEY: 'k', GOOGLE_SHOPPING: '0' }).name, 'amazon');
  assert.throws(() => pickProvider({ SERPAPI_KEY: 'k', GOOGLE_SHOPPING: '0', AMAZON_DOMAINS: '' }), /Nothing to search/);
});

test('storeSeries groups history per matching store', () => {
  const product = {
    history: [
      { t: 1, offers: [{ store: 'Amazon.de', price: 10 }, { store: 'bol.com', price: 9 }] },
      { t: 2, offers: [{ store: 'Amazon.de', price: 8 }] },
    ],
  };
  assert.deepEqual(storeSeries(product, (s) => s.startsWith('Amazon.')), [
    { store: 'Amazon.de', points: [{ t: 1, price: 10 }, { t: 2, price: 8 }] },
  ]);
});
