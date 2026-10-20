import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { demoProvider } from '../providers/demo.js';

async function start(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pricewatch-'));
  const app = await createApp({ dataFile: join(dir, 'db.json'), provider: demoProvider, ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const stop = async () => { app.server.close(); await rm(dir, { recursive: true }); };
  return { app, base, stop };
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

test('with a password set, every request needs it', async () => {
  const { base, stop } = await start({ password: 's3cret:with:colons' });
  try {
    for (const path of ['/', '/api/state', '/app.js']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 401, path);
      assert.match(res.headers.get('www-authenticate'), /^Basic/);
    }
    const wrong = await fetch(`${base}/api/state`, { headers: { Authorization: basic('me', 'nope') } });
    assert.equal(wrong.status, 401);
    const noColon = await fetch(`${base}/api/state`, { headers: { Authorization: `Basic ${Buffer.from('s3cret').toString('base64')}` } });
    assert.equal(noColon.status, 401);
    const ok = await fetch(`${base}/api/state`, { headers: { Authorization: basic('anyone', 's3cret:with:colons') } });
    assert.equal(ok.status, 200);
  } finally {
    await stop();
  }
});

test('without a password nothing is asked for', async () => {
  const { base, stop } = await start();
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 200);
  } finally {
    await stop();
  }
});

test('refreshStale only refreshes products that are due, and failures are not retried every tick', async () => {
  let calls = 0;
  const flaky = { name: 'flaky', demo: false, fetchOffers: async () => { calls++; throw new Error('down'); } };
  const { app, stop } = await start({ provider: flaky });
  try {
    const product = { id: 'p1', name: 'Thing', targetPrice: null, createdAt: Date.now(), history: [] };
    app.db.products.push(product);
    assert.equal(await app.refreshStale(60_000), 1); // never attempted: due
    assert.equal(calls, 1);
    assert.equal(await app.refreshStale(60_000), 0); // attempted just now, even though it failed
    assert.equal(calls, 1);
    assert.equal(await app.refreshStale(0), 1); // a zero max age makes everything due
  } finally {
    await stop();
  }
});

test('refuses to listen on the network without a password', () => {
  const run = (env) => spawnSync(process.execPath, ['server.js'], {
    env: { PATH: process.env.PATH, PORT: '0', DATA_FILE: join(tmpdir(), 'pw-guard.json'), ...env },
    encoding: 'utf8',
    timeout: 3000,
  });
  const refused = run({ HOST: '0.0.0.0' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /AUTH_PASSWORD/);
  // With a password it starts (and is then killed by the timeout).
  const started = run({ HOST: '127.0.0.1', AUTH_PASSWORD: 'x' });
  assert.doesNotMatch(started.stderr, /AUTH_PASSWORD/);
});
