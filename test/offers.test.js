import test from 'node:test';
import assert from 'node:assert/strict';
import { bestOffer, filterOutliers, summarize } from '../lib/offers.js';
import { demoProvider } from '../providers/demo.js';
import { parseShoppingResults } from '../providers/serpapi.js';

const o = (store, price) => ({ store, price });

test('bestOffer picks the cheapest', () => {
  assert.deepEqual(bestOffer([o('A', 30), o('B', 10), o('C', 20)]), o('B', 10));
  assert.equal(bestOffer([]), null);
});

test('filterOutliers drops accessory-priced results only when there are enough offers', () => {
  const offers = [o('A', 300), o('B', 310), o('C', 295), o('Case shop', 12)];
  assert.deepEqual(filterOutliers(offers).map((x) => x.store), ['A', 'B', 'C']);
  assert.equal(filterOutliers([o('A', 300), o('B', 12)]).length, 2);
});

test('summarize reports best price, change vs previous check, and target hit', () => {
  const product = {
    id: '1', name: 'Thing', targetPrice: 95,
    history: [
      { t: 1, offers: [o('A', 120), o('B', 110)] },
      { t: 2, offers: [o('A', 100), o('B', 90)] },
    ],
  };
  const s = summarize(product);
  assert.equal(s.best.price, 90);
  assert.equal(s.change, -20);
  assert.equal(s.changePct, -18.18);
  assert.equal(s.allTimeLow, 90);
  assert.equal(s.allTimeHigh, 110);
  assert.equal(s.averageOffer, 95);
  assert.equal(s.savingsVsAverage, 5);
  assert.equal(s.atTarget, true);
});

test('summarize copes with a product that has no history', () => {
  const s = summarize({ id: '1', name: 'New', history: [] });
  assert.equal(s.best, null);
  assert.equal(s.atTarget, false);
});

test('demo provider is deterministic for a given time and backfills 30 days', async () => {
  const a = demoProvider.backfill('Sony WH-1000XM5', 1_700_000_000_000);
  const b = demoProvider.backfill('Sony WH-1000XM5', 1_700_000_000_000);
  assert.deepEqual(a, b);
  assert.equal(a.length, 60);
  assert.ok(a[0].offers.length >= 3);
});

test('parseShoppingResults keeps the cheapest offer per store and ignores bad rows', () => {
  const offers = parseShoppingResults({
    shopping_results: [
      { source: 'Amazon', extracted_price: 99, product_link: 'https://a.example/x' },
      { source: 'Amazon', extracted_price: 89, product_link: 'javascript:alert(1)' },
      { source: 'Walmart', extracted_price: 95, link: 'https://w.example/y' },
      { source: 'NoPrice' },
      { extracted_price: 10 },
    ],
  });
  assert.deepEqual(offers.map((x) => [x.store, x.price]), [['Amazon', 89], ['Walmart', 95]]);
  assert.equal(offers[0].url, null);
});
