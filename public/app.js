const $ = (sel) => document.querySelector(sel);

const NS = 'http://www.w3.org/2000/svg';
const DAY = 86_400_000;

let state = { provider: { name: '', demo: false }, currency: 'USD', products: [] };
let selectedId = null;
let range = 30; // days; 0 = all
let historyCache = { id: null, points: [] };

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

const money = (n, digits) =>
  n == null
    ? '—'
    : new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: state.currency,
        minimumFractionDigits: digits ?? (Number.isInteger(n) ? 0 : 2),
        maximumFractionDigits: digits ?? 2,
      }).format(n);

const dateShort = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const dateTime = (t) =>
  new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function ago(t) {
  if (!t) return 'never';
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
}

const safeHref = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

function showError(err) {
  const el = $('#error');
  el.hidden = !err;
  el.textContent = err ? err.message ?? String(err) : '';
}

async function guarded(button, fn) {
  button.disabled = true;
  try {
    showError(null);
    await fn();
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
  }
}

// ---------- summary + table ----------

function changeCell(p) {
  if (p.change == null) return h('span', { class: 'muted' }, '—');
  if (p.change === 0) return h('span', { class: 'muted' }, 'No change');
  const down = p.change < 0;
  return h(
    'span',
    { class: down ? 'down' : 'up' },
    down ? '▼ ' : '▲ ',
    `${money(Math.abs(p.change))} (${Math.abs(p.changePct)}%)`,
    h('span', { class: 'sr', style: 'position:absolute;left:-9999px' }, down ? ' cheaper' : ' pricier'),
  );
}

function sparkline(points) {
  const w = 96, hgt = 28, pad = 3;
  if (points.length < 2) return h('span', { class: 'muted' }, '—');
  const prices = points.map((p) => p.price);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const x = (i) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v) => (hi === lo ? hgt / 2 : hgt - pad - ((v - lo) / (hi - lo)) * (hgt - pad * 2));
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.price).toFixed(1)}`).join('');
  return svg(
    'svg',
    { class: 'spark', viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': `Best price trend, ${money(lo)} to ${money(hi)}` },
    svg('path', { d, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    svg('circle', { cx: x(points.length - 1), cy: y(prices.at(-1)), r: 3.5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }),
  );
}

function renderKpis() {
  const ps = state.products;
  const drops = ps.filter((p) => p.change != null && p.change < 0).length;
  const atTarget = ps.filter((p) => p.atTarget).length;
  const savings = ps.reduce((a, p) => a + (p.savingsVsAverage ?? 0), 0);
  const kpi = (label, value) => h('div', { class: 'kpi card' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
  $('#kpis').replaceChildren(
    kpi('Products tracked', String(ps.length)),
    kpi('At or below target', String(atTarget)),
    kpi('Price drops since last check', String(drops)),
    kpi('Saved vs. average store', money(savings)),
  );
}

function renderTable() {
  const rows = state.products.map((p) => {
    const select = () => selectProduct(p.id);
    return h(
      'tr',
      { 'aria-selected': String(p.id === selectedId), onclick: select },
      h(
        'td',
        { class: 'name' },
        h('button', { type: 'button', onclick: (e) => { e.stopPropagation(); select(); } }, p.name),
        p.lastError ? h('div', { class: 'muted up' }, `⚠ ${p.lastError}`) : h('div', { class: 'muted' }, `Checked ${ago(p.lastChecked)}`),
      ),
      h('td', { class: 'num price' }, money(p.best?.price), p.atTarget ? h('span', { class: 'chip down' }, '✓ Target hit') : null),
      h('td', {}, p.best?.store ?? '—'),
      h('td', { class: 'num' }, changeCell(p)),
      h('td', { class: 'hide-sm' }, p.targetPrice != null ? money(p.targetPrice) : h('span', { class: 'muted' }, '—')),
      h('td', { class: 'hide-sm' }, sparkline(p.spark)),
    );
  });
  $('#products tbody').replaceChildren(...rows);
  $('#empty').hidden = state.products.length > 0;
  $('#products').hidden = state.products.length === 0;
}

function renderHeader() {
  const { demo, name } = state.provider;
  const banner = $('#banner');
  banner.hidden = !demo;
  if (demo) {
    banner.textContent =
      'Demo mode: these prices are simulated. Set SERPAPI_KEY and restart to track real Google Shopping prices (see README).';
  }
  $('#sub').textContent = `Best online price for the things you're watching · source: ${name}`;
}

// ---------- detail panel + chart ----------

async function selectProduct(id) {
  selectedId = id;
  renderTable();
  await loadHistory();
  renderDetail();
  $('#detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function loadHistory() {
  if (!selectedId) return;
  const id = selectedId;
  try {
    const points = await api('GET', `/api/products/${id}/history`);
    historyCache = { id, points };
  } catch (err) {
    showError(err);
  }
}

function renderDetail() {
  const panel = $('#detail');
  const p = state.products.find((x) => x.id === selectedId);
  if (!p) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const points = historyCache.id === p.id ? historyCache.points : [];
  const cutoff = range ? Date.now() - range * DAY : 0;
  const visible = points.filter((pt) => pt.t >= cutoff);
  const chartBox = h('div', { class: 'chart' });

  const targetInput = h('input', {
    type: 'number', min: '0.01', step: '0.01', inputmode: 'decimal', 'aria-label': 'Target price',
    placeholder: 'Target', value: p.targetPrice ?? '',
  });
  const saveBtn = h('button', { type: 'button' }, 'Set target');
  saveBtn.onclick = () => guarded(saveBtn, async () => {
    await api('PATCH', `/api/products/${p.id}`, { targetPrice: targetInput.value === '' ? null : targetInput.value });
    await reload();
  });
  const refreshBtn = h('button', { type: 'button' }, 'Check now');
  refreshBtn.onclick = () => guarded(refreshBtn, async () => {
    await api('POST', `/api/products/${p.id}/refresh`);
    await reload();
  });
  const removeBtn = h('button', { type: 'button', class: 'link' }, 'Stop tracking');
  removeBtn.onclick = () => guarded(removeBtn, async () => {
    if (!confirm(`Stop tracking "${p.name}"? Its price history will be deleted.`)) return;
    await api('DELETE', `/api/products/${p.id}`);
    selectedId = null;
    await reload();
  });

  const rangeButtons = [[7, '7 days'], [30, '30 days'], [0, 'All']].map(([d, label]) =>
    h('button', { type: 'button', 'aria-pressed': String(range === d), onclick: () => { range = d; renderDetail(); } }, label),
  );

  const maxOffer = Math.max(...p.offers.map((o) => o.price), 1);
  const best = p.best;
  const offerRows = p.offers.map((o, i) => {
    const href = safeHref(o.url);
    const store = href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, o.store) : o.store;
    return h(
      'div',
      { class: 'offer' },
      h('span', {}, store),
      h('span', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${(o.price / maxOffer) * 100}%` })),
      h('span', { class: 'amt' }, h('b', {}, money(o.price)), i > 0 && best ? h('span', { class: 'muted' }, ` +${money(o.price - best.price)}`) : h('span', { class: 'muted' }, ' lowest')),
    );
  });

  const dataTable = h(
    'details',
    {},
    h('summary', {}, 'View data as a table'),
    h('div', { class: 'scroll' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Checked'), h('th', { scope: 'col', class: 'num' }, 'Best price'), h('th', { scope: 'col' }, 'Store'))),
        h('tbody', {}, [...visible].reverse().map((pt) => h('tr', {}, h('td', {}, dateTime(pt.t)), h('td', { class: 'num' }, money(pt.price)), h('td', {}, pt.store)))),
      ),
    ),
  );

  panel.replaceChildren(
    h('div', { class: 'detail-head' },
      h('div', {},
        h('h2', {}, p.name),
        h('div', { class: 'muted' },
          `All-time low ${money(p.allTimeLow)} · high ${money(p.allTimeHigh)} · average store ${money(p.averageOffer)}`),
      ),
      h('div', { class: 'detail-actions' }, targetInput, saveBtn, refreshBtn, removeBtn),
    ),
    h('div', { class: 'ranges', role: 'group', 'aria-label': 'Time range' }, rangeButtons),
    chartBox,
    h('div', { class: 'offers' }, h('h3', {}, `Current offers (${p.offers.length})`), offerRows.length ? offerRows : h('p', { class: 'muted' }, 'No offers found yet.')),
    dataTable,
  );

  drawChart(chartBox, visible, p.targetPrice);
}

function niceTicks(lo, hi, count = 4) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = start; v < hi + step; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

function drawChart(box, points, target) {
  if (points.length < 2) {
    box.replaceChildren(h('p', { class: 'muted' }, 'Not enough history in this range yet. Prices are re-checked automatically.'));
    return;
  }
  const W = Math.max(box.clientWidth, 320), H = 280;
  const m = { top: 14, right: 16, bottom: 28, left: 56 };
  const prices = points.map((p) => p.price);
  let lo = Math.min(...prices), hi = Math.max(...prices);
  const showTarget = target != null && target >= lo * 0.6 && target <= hi * 1.4;
  if (showTarget) { lo = Math.min(lo, target); hi = Math.max(hi, target); }
  const ticks = niceTicks(lo, hi);
  const yMin = ticks[0], yMax = ticks.at(-1);
  const t0 = points[0].t, t1 = points.at(-1).t;
  const x = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * (W - m.left - m.right);
  const y = (v) => m.top + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - m.top - m.bottom);

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Best price over time for the selected product, from ${money(Math.min(...prices))} to ${money(Math.max(...prices))}` });

  for (const v of ticks) {
    root.append(
      svg('line', { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }),
      Object.assign(svg('text', { x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end' }), { textContent: money(v, 0) }),
    );
  }
  const xTicks = W < 520 ? 2 : 4;
  for (let i = 0; i <= xTicks; i++) {
    const t = t0 + ((t1 - t0) * i) / xTicks;
    root.append(Object.assign(svg('text', { x: x(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === xTicks ? 'end' : 'middle' }), { textContent: dateShort(t) }));
  }

  if (showTarget) {
    root.append(
      svg('line', { x1: m.left, x2: W - m.right, y1: y(target), y2: y(target), stroke: 'var(--text-muted)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }),
      Object.assign(svg('text', { x: W - m.right, y: y(target) - 6, 'text-anchor': 'end' }), { textContent: `Target ${money(target)}` }),
    );
  }

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.price).toFixed(1)}`).join('');
  root.append(svg('path', { d, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // Direct label on the low point and the latest point (not every point).
  const lowPt = points.reduce((a, b) => (b.price < a.price ? b : a));
  const last = points.at(-1);
  const mark = (pt, label, anchor) => {
    root.append(
      svg('circle', { cx: x(pt.t), cy: y(pt.price), r: 4.5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }),
      Object.assign(svg('text', { x: x(pt.t), y: y(pt.price) + 20, 'text-anchor': anchor, style: 'font-weight:600' }), { textContent: label }),
    );
  };
  mark(lowPt, `Low ${money(lowPt.price)}`, x(lowPt.t) < m.left + 50 ? 'start' : x(lowPt.t) > W - m.right - 50 ? 'end' : 'middle');
  if (last !== lowPt) mark(last, `Now ${money(last.price)}`, 'end');

  // Hover layer: crosshair + tooltip following the nearest snapshot.
  const cross = svg('line', { y1: m.top, y2: H - m.bottom, stroke: 'var(--text-muted)', 'stroke-width': 1, visibility: 'hidden' });
  const dot = svg('circle', { r: 5.5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' });
  const hit = svg('rect', { x: m.left, y: m.top, width: W - m.left - m.right, height: H - m.top - m.bottom, fill: 'transparent' });
  root.append(cross, dot, hit);

  const tip = $('#tooltip');
  const show = (clientX, clientY) => {
    const rect = root.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    let nearest = points[0];
    for (const p of points) if (Math.abs(x(p.t) - px) < Math.abs(x(nearest.t) - px)) nearest = p;
    cross.setAttribute('x1', x(nearest.t)); cross.setAttribute('x2', x(nearest.t));
    dot.setAttribute('cx', x(nearest.t)); dot.setAttribute('cy', y(nearest.price));
    cross.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
    tip.replaceChildren(h('div', { class: 'muted' }, dateTime(nearest.t)), h('div', {}, h('b', {}, money(nearest.price)), ` at ${nearest.store}`));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(clientX + 14, window.innerWidth - tw - 8)}px`;
    tip.style.top = `${clientY + 14}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden');
  };
  hit.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointerdown', (e) => show(e.clientX, e.clientY));

  box.replaceChildren(root);
}

// ---------- data flow ----------

function render() {
  renderHeader();
  renderKpis();
  renderTable();
  renderDetail();
}

async function reload() {
  state = await api('GET', '/api/state');
  if (selectedId && !state.products.some((p) => p.id === selectedId)) selectedId = null;
  await loadHistory();
  render();
}

$('#add').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const data = new FormData(form);
  guarded(form.querySelector('button'), async () => {
    const created = await api('POST', '/api/products', { name: data.get('name'), targetPrice: data.get('targetPrice') });
    form.reset();
    selectedId = created.id;
    await reload();
  });
});

$('#refresh-all').addEventListener('click', (e) => guarded(e.currentTarget, async () => {
  state = await api('POST', '/api/refresh');
  await loadHistory();
  render();
}));

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderDetail, 150);
});

reload().catch(showError);
// Pick up background refreshes done by the server.
setInterval(() => reload().catch(() => {}), 60_000);
