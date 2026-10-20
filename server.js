import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Db, MAX_SNAPSHOTS } from './lib/db.js';
import { filterOutliers, historySeries, storeSeries, summarize } from './lib/offers.js';
import { pickProvider } from './providers/index.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const MAX_PRODUCTS = 100;
const MAX_BODY = 10_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseTarget(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) {
    throw new HttpError(400, 'targetPrice must be a positive number');
  }
  return Math.round(n * 100) / 100;
}

function parseName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 120) throw new HttpError(400, 'name must be 1-120 characters');
  return name;
}

export async function createApp({ dataFile, provider, currency = 'USD' }) {
  const db = await new Db(dataFile).load();
  const inFlight = new Set();

  async function refresh(product) {
    if (inFlight.has(product.id)) return;
    inFlight.add(product.id);
    try {
      const raw = await provider.fetchOffers(product.name);
      const warnings = raw.warnings ?? [];
      const offers = filterOutliers(raw);
      product.history.push({ t: Date.now(), offers });
      if (product.history.length > MAX_SNAPSHOTS) {
        product.history.splice(0, product.history.length - MAX_SNAPSHOTS);
      }
      product.lastError = warnings.length ? warnings.join('; ') : offers.length ? null : 'No offers found for this search';
    } catch (err) {
      product.lastError = err.message;
    } finally {
      inFlight.delete(product.id);
    }
  }

  async function refreshAll() {
    for (const product of db.products) await refresh(product);
    await db.save();
  }

  const state = () => ({
    provider: { name: provider.name, demo: provider.demo },
    currency,
    products: db.products.map((p) => summarize(p)),
  });

  const need = (id) => {
    const product = db.find(id);
    if (!product) throw new HttpError(404, 'Product not found');
    return product;
  };

  async function route(method, path, body) {
    if (method === 'GET' && path === '/api/state') return state();

    if (method === 'POST' && path === '/api/refresh') {
      await refreshAll();
      return state();
    }

    if (method === 'POST' && path === '/api/products') {
      if (db.products.length >= MAX_PRODUCTS) throw new HttpError(400, 'Product limit reached');
      const name = parseName(body.name);
      const product = {
        id: randomUUID(),
        name,
        targetPrice: parseTarget(body.targetPrice),
        createdAt: Date.now(),
        history: provider.backfill?.(name) ?? [],
      };
      db.products.push(product);
      await refresh(product);
      await db.save();
      return summarize(product);
    }

    const match = path.match(/^\/api\/products\/([\w-]+)(\/history|\/refresh|\/amazon)?$/);
    if (match) {
      const [, id, sub] = match;
      const product = need(id);

      if (method === 'GET' && sub === '/history') return historySeries(product);

      if (method === 'GET' && sub === '/amazon') return storeSeries(product, (s) => /^amazon\./i.test(s));

      if (method === 'POST' && sub === '/refresh') {
        await refresh(product);
        await db.save();
        return summarize(product);
      }

      if (method === 'PATCH' && !sub) {
        if ('targetPrice' in body) product.targetPrice = parseTarget(body.targetPrice);
        await db.save();
        return summarize(product);
      }

      if (method === 'DELETE' && !sub) {
        db.data.products = db.products.filter((p) => p !== product);
        await db.save();
        return { ok: true };
      }
    }

    throw new HttpError(404, 'Not found');
  }

  async function serveStatic(res, urlPath) {
    const rel = normalize(urlPath === '/' ? '/index.html' : urlPath);
    const file = resolve(PUBLIC_DIR, `.${rel}`);
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, 'Not found');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'Not found');
    }
  }

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed === null || typeof parsed !== 'object') throw new Error();
      return parsed;
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/')) {
        const result = await route(req.method, pathname, await readBody(req));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
      } else if (req.method === 'GET') {
        await serveStatic(res, pathname);
      } else {
        throw new HttpError(405, 'Method not allowed');
      }
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'Internal error' : err.message }));
    }
  });

  return { server, refreshAll, db };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const provider = pickProvider();
  const port = Number(process.env.PORT ?? 3000);
  // Bound to localhost: the API has no authentication.
  const host = process.env.HOST ?? '127.0.0.1';
  const defaultMinutes = provider.demo ? 60 : 1440;
  const minutes = Number(process.env.REFRESH_MINUTES ?? defaultMinutes);

  const { server, refreshAll } = await createApp({
    dataFile: process.env.DATA_FILE ?? join(ROOT, 'data', 'db.json'),
    provider,
    currency: process.env.CURRENCY ?? 'EUR',
  });

  server.listen(port, host, () => {
    console.log(`Pricewatch on http://${host}:${port} (provider: ${provider.name}, refresh every ${minutes} min)`);
  });
  if (minutes > 0) setInterval(() => refreshAll().catch(console.error), minutes * 60_000).unref();
}
