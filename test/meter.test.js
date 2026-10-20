import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoRefreshMs, BudgetError, Meter, meteredFetch, periodEnd, periodStart } from '../lib/meter.js';
import { createApp } from '../server.js';

const at = (iso) => Date.parse(iso);

test('billing period starts on the reset day, rolling back before it', () => {
  assert.equal(periodStart(at('2026-10-20T12:00:00Z'), 1), at('2026-10-01T00:00:00Z'));
  assert.equal(periodStart(at('2026-10-20T12:00:00Z'), 25), at('2026-09-25T00:00:00Z'));
  assert.equal(periodStart(at('2026-01-10T00:00:00Z'), 15), at('2025-12-15T00:00:00Z'));
  assert.equal(periodEnd(at('2026-12-15T00:00:00Z'), 15), at('2027-01-15T00:00:00Z'));
});

test('meter counts searches, refuses past the limit, persists, and resets in a new period', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-meter-'));
  try {
    let now = at('2026-10-20T00:00:00Z');
    const make = () => new Meter({ file: join(dir, 'usage.json'), limit: 3, now: () => now });
    const meter = await make().load();
    assert.equal(meter.canAfford(3), true);
    meter.use(); meter.use();
    assert.equal(meter.canAfford(2), false);
    meter.use();
    assert.throws(() => meter.use(), BudgetError);
    await meter.queue;

    assert.equal((await make().load()).snapshot().used, 3); // survives a restart

    now = at('2026-11-02T00:00:00Z');
    assert.deepEqual(
      (await make().load()).snapshot(),
      { used: 0, limit: 3, remaining: 3, resetsAt: at('2026-12-01T00:00:00Z') },
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('meteredFetch spends one search per call and stops when the budget is gone', async () => {
  const meter = { n: 0, use() { if (this.n >= 2) throw new BudgetError('used up'); this.n++; } };
  let calls = 0;
  const f = meteredFetch(meter, async () => { calls++; return 'ok'; });
  assert.equal(await f('u'), 'ok');
  assert.equal(await f('u'), 'ok');
  assert.throws(() => f('u'), /used up/);
  assert.equal(calls, 2);
});

test('autoRefreshMs spreads the budget, keeping a reserve and a 6h floor', () => {
  const h = 3_600_000;
  // 250 searches, 5 per refresh, 1 product: floor(212.5/5)=42 refreshes in 30 days.
  assert.equal(autoRefreshMs({ products: 1, costPerRefresh: 5, limit: 250 }), Math.round((30 * 24 * h) / 42));
  // 3 products: floor(212.5/15)=14 refreshes -> about every 51 hours.
  assert.equal(Math.round(autoRefreshMs({ products: 3, costPerRefresh: 5, limit: 250 }) / h), 51);
  assert.equal(autoRefreshMs({ products: 1, costPerRefresh: 1, limit: 10_000 }), 6 * h);
  assert.equal(autoRefreshMs({ products: 100, costPerRefresh: 5, limit: 250 }), Infinity);
  assert.equal(autoRefreshMs({ products: 0, costPerRefresh: 5, limit: 250 }), 24 * h);
});

test('a refresh that the budget cannot cover is skipped whole, with a clear message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-budget-'));
  try {
    let calls = 0;
    const provider = { name: 'live', demo: false, cost: 5, fetchOffers: async () => { calls++; return [{ store: 'A', price: 10 }]; } };
    const meter = await new Meter({ file: join(dir, 'usage.json'), limit: 7 }).load();
    for (let i = 0; i < 3; i++) meter.use(); // 3 of 7 spent, 4 left < 5 needed
    const app = await createApp({ dataFile: join(dir, 'db.json'), provider, meter });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    try {
      const created = await (await fetch(`${base}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Thing' }) })).json();
      assert.equal(calls, 0);
      assert.match(created.lastError, /budget used up \(3\/7\)/);
      assert.equal(created.best, null);
      const state = await (await fetch(`${base}/api/state`)).json();
      assert.deepEqual([state.usage.used, state.usage.limit, state.usage.remaining, state.usage.cost], [3, 7, 4, 5]);
    } finally {
      app.server.close();
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});
