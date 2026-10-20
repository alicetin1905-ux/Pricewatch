import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { demoProvider } from '../providers/demo.js';

async function start(provider = demoProvider) {
  const dir = await mkdtemp(join(tmpdir(), 'pricewatch-'));
  const app = await createApp({ dataFile: join(dir, 'db.json'), provider });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null), res };
  };
  const stop = async () => { app.server.close(); await rm(dir, { recursive: true }); };
  return { call, stop, base };
}

test('create, list, update, refresh and delete a product', async () => {
  const { call, stop } = await start();
  try {
    const created = await call('POST', '/api/products', { name: 'Sony WH-1000XM5', targetPrice: '250' });
    assert.equal(created.status, 200);
    assert.ok(created.json.best.price > 0);
    assert.equal(created.json.targetPrice, 250);

    const id = created.json.id;
    assert.equal((await call('GET', '/api/state')).json.products.length, 1);
    assert.ok((await call('GET', `/api/products/${id}/history`)).json.length > 50);

    const compare = (await call('GET', `/api/products/${id}/compare`)).json;
    assert.deepEqual(compare.map((s) => s.store), ['Amazon.com.be', 'Amazon.nl', 'Amazon.de', 'bol.com']);
    assert.ok(compare.every((s) => s.points.length > 50));

    assert.equal((await call('PATCH', `/api/products/${id}`, { targetPrice: null })).json.targetPrice, null);
    assert.equal((await call('POST', `/api/products/${id}/refresh`)).status, 200);
    assert.equal((await call('DELETE', `/api/products/${id}`)).status, 200);
    assert.equal((await call('GET', '/api/state')).json.products.length, 0);
  } finally {
    await stop();
  }
});

test('rejects bad input', async () => {
  const { call, stop } = await start();
  try {
    assert.equal((await call('POST', '/api/products', { name: '  ' })).status, 400);
    assert.equal((await call('POST', '/api/products', { name: 'x', targetPrice: -5 })).status, 400);
    assert.equal((await call('POST', '/api/products', { name: 123 })).status, 400);
    assert.equal((await call('GET', '/api/products/nope/history')).status, 404);
  } finally {
    await stop();
  }
});

test('a provider failure is recorded on the product instead of crashing', async () => {
  const failing = { name: 'failing', demo: false, fetchOffers: async () => { throw new Error('boom'); } };
  const { call, stop } = await start(failing);
  try {
    const created = await call('POST', '/api/products', { name: 'Anything' });
    assert.equal(created.status, 200);
    assert.equal(created.json.lastError, 'boom');
    assert.equal(created.json.best, null);
  } finally {
    await stop();
  }
});

test('static files are served and path traversal is refused', async () => {
  const { base, stop } = await start();
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Pricewatch/);
    const evil = await fetch(`${base}/..%2fpackage.json`);
    assert.equal(evil.status, 404);
  } finally {
    await stop();
  }
});
