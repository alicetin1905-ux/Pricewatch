import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Db, MAX_SNAPSHOTS } from './lib/db.js';
import { autoRefreshMs, Meter } from './lib/meter.js';
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

const digest = (text) => createHash('sha256').update(text).digest();

// HTTP Basic auth: any username, the configured password.
function isAuthorized(req, passwordDigest) {
  if (!passwordDigest) return true;
  const header = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
  if (!header) return false;
  const decoded = Buffer.from(header[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon >= 0 && timingSafeEqual(digest(decoded.slice(colon + 1)), passwordDigest);
}

export async function createApp({ dataFile, provider, currency = 'USD', password = '', meter = null }) {
  const passwordDigest = password ? digest(password) : null;
  const db = await new Db(dataFile).load();
  const inFlight = new Set();

  async function refresh(product) {
    if (inFlight.has(product.id)) return;
    inFlight.add(product.id);
    product.lastAttempt = Date.now();
    // A refresh that can't finish would leave a snapshot with stores missing, so it's all or nothing.
    if (meter && !meter.canAfford(provider.cost ?? 0)) {
      product.lastError = meter.exhaustedMessage();
      inFlight.delete(product.id);
      return;
    }
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

  // Timers don't count time the machine spends asleep, so rather than one long
  // interval the caller polls this and each product is refreshed once it's due.
  async function refreshStale(maxAgeMs) {
    const due = db.products.filter((p) => Date.now() - (p.lastAttempt ?? p.history.at(-1)?.t ?? 0) >= maxAgeMs);
    for (const product of due) await refresh(product);
    if (due.length) await db.save();
    return due.length;
  }

  const state = () => ({
    provider: { name: provider.name, demo: provider.demo },
    currency,
    usage: meter ? { ...meter.snapshot(), cost: provider.cost ?? 0 } : null,
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

    const match = path.match(/^\/api\/products\/([\w-]+)(\/history|\/refresh|\/compare)?$/);
    if (match) {
      const [, id, sub] = match;
      const product = need(id);

      if (method === 'GET' && sub === '/history') return historySeries(product);

      if (method === 'GET' && sub === '/compare') return storeSeries(product, (s) => /^amazon\.|^bol\.com$/i.test(s));

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
    if (!isAuthorized(req, passwordDigest)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Pricewatch", charset="UTF-8"' });
      res.end('Authentication required');
      return;
    }
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

  return { server, refreshAll, refreshStale, db };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // Settings can live in a .env file next to this one (see .env.example).
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const password = process.env.AUTH_PASSWORD ?? '';
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!loopback && !password) {
    throw new Error(`HOST=${host} exposes Pricewatch to the network; set AUTH_PASSWORD first`);
  }

  const dataFile = process.env.DATA_FILE ?? join(ROOT, 'data', 'db.json');
  const limit = Number(process.env.SERPAPI_MONTHLY_LIMIT ?? 250);
  const resetDay = Number(process.env.SERPAPI_RESET_DAY ?? 1);
  if (!Number.isInteger(limit) || limit < 0) throw new Error('SERPAPI_MONTHLY_LIMIT must be a whole number (0 = unlimited)');
  if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28) throw new Error('SERPAPI_RESET_DAY must be 1-28');

  const searchMeter = limit > 0 ? await new Meter({ file: join(dirname(dataFile), 'usage.json'), limit, resetDay }).load() : null;
  const provider = pickProvider(process.env, { meter: searchMeter });
  const meter = provider.demo ? null : searchMeter;

  const { server, refreshStale, db } = await createApp({
    dataFile,
    provider,
    currency: process.env.CURRENCY ?? 'EUR',
    password,
    meter,
  });

  // REFRESH_MINUTES pins the interval; otherwise live sources are paced to fit the search budget.
  const fixedMinutes = process.env.REFRESH_MINUTES;
  const refreshMs = () => {
    if (fixedMinutes != null) return Number(fixedMinutes) * 60_000;
    if (provider.demo || !meter) return (provider.demo ? 60 : 1440) * 60_000;
    return autoRefreshMs({ products: db.products.length, costPerRefresh: provider.cost, limit: meter.limit });
  };

  server.listen(port, host, () => {
    const every = fixedMinutes != null ? `every ${fixedMinutes} min` : meter ? 'paced to the search budget' : 'hourly';
    const budget = meter ? `, ${meter.limit} searches/month` : '';
    console.log(`Pricewatch on http://${host}:${port} (provider: ${provider.name}, refresh ${every}${budget}${password ? ', password required' : ''})`);
  });
  if (refreshMs() > 0) {
    const tick = () => {
      const ms = refreshMs();
      if (ms > 0 && Number.isFinite(ms)) refreshStale(ms).catch(console.error);
    };
    tick();
    setInterval(tick, 5 * 60_000).unref();
  }
}
