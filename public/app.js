const $ = (sel) => document.querySelector(sel);

const NS = 'http://www.w3.org/2000/svg';
const DAY = 86_400_000;

let state = { provider: { name: '', demo: false }, currency: 'USD', products: [] };
let selectedId = null;
let range = 30; // days; 0 = all
let historyCache = { id: null, points: [], amazon: [] };
let chartMode = 'best'; // 'best' | 'amazon'

const STORE_COLORS = { 'Amazon.com.be': 'var(--series-1)', 'Amazon.nl': 'var(--series-2)', 'Amazon.de': 'var(--series-3)' };
const FALLBACK_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
const storeColor = (store, i) => STORE_COLORS[store] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
const isAmazon = (store) => /^amazon\./i.test(store);

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
    const [points, amazon] = await Promise.all([
      api('GET', `/api/products/${id}/history`),
      api('GET', `/api/products/${id}/amazon`),
    ]);
    historyCache = { id, points, amazon };
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

  const cache = historyCache.id === p.id ? historyCache : { points: [], amazon: [] };
  const cutoff = range ? Date.now() - range * DAY : 0;
  const inRange = (pt) => pt.t >= cutoff;
  const visible = cache.points.filter(inRange);
  const amazonSeries = cache.amazon
    .map((s, i) => ({ name: s.store, color: storeColor(s.store, i), points: s.points.filter(inRange) }))
    .filter((s) => s.points.length);
  const hasAmazon = cache.amazon.length > 1;
  if (!hasAmazon) chartMode = 'best';
  const amazonMode = chartMode === 'amazon';
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

  const toggle = (value, label, current, set) =>
    h('button', { type: 'button', 'aria-pressed': String(current === value), onclick: () => { set(value); renderDetail(); } }, label);
  const modeButtons = hasAmazon
    ? h('div', { class: 'ranges', role: 'group', 'aria-label': 'Chart' },
        toggle('best', 'Best price', chartMode, (v) => (chartMode = v)),
        toggle('amazon', 'Amazon marketplaces', chartMode, (v) => (chartMode = v)))
    : null;
  const rangeButtons = h('div', { class: 'ranges', role: 'group', 'aria-label': 'Time range' },
    [[7, '7 days'], [30, '30 days'], [0, 'All']].map(([d, label]) => toggle(d, label, range, (v) => (range = v))));

  // Which Amazon marketplace is cheapest right now, and by how much.
  const amazonNow = p.offers.filter((o) => isAmazon(o.store));
  let amazonSummary = null;
  if (amazonMode && amazonNow.length > 1) {
    const [cheapest, ...rest] = amazonNow;
    const dearest = rest.at(-1);
    amazonSummary = h('p', { class: 'summary' },
      h('b', {}, cheapest.store), ` is cheapest right now at ${money(cheapest.price)}, `,
      `${money(dearest.price - cheapest.price)} (${Math.round(((dearest.price - cheapest.price) / dearest.price) * 100)}%) less than ${dearest.store}.`);
  }

  const legend = amazonMode
    ? h('ul', { class: 'legend' }, amazonSeries.map((s) => h('li', {}, h('i', { style: `background:${s.color}` }), s.name)))
    : null;

  const maxOffer = Math.max(...p.offers.map((o) => o.price), 1);
  const best = p.best;
  const offerRows = p.offers.map((o, i) => {
    const href = safeHref(o.url);
    const store = href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, o.store) : o.store;
    return h(
      'div',
      { class: 'offer' },
      h('span', {}, store, o.title ? h('div', { class: 'muted clip', title: o.title }, o.title) : null),
      h('span', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${(o.price / maxOffer) * 100}%` })),
      h('span', { class: 'amt' }, h('b', {}, money(o.price)), i > 0 && best ? h('span', { class: 'muted' }, ` +${money(o.price - best.price)}`) : h('span', { class: 'muted' }, ' lowest')),
    );
  });

  let tableHead, tableRows;
  if (amazonMode) {
    const times = [...new Set(amazonSeries.flatMap((s) => s.points.map((pt) => pt.t)))].sort((a, b) => b - a);
    tableHead = ['Checked', ...amazonSeries.map((s) => s.name)];
    tableRows = times.map((t) => [dateTime(t), ...amazonSeries.map((s) => money(s.points.find((pt) => pt.t === t)?.price))]);
  } else {
    tableHead = ['Checked', 'Best price', 'Store'];
    tableRows = [...visible].reverse().map((pt) => [dateTime(pt.t), money(pt.price), pt.store]);
  }
  const dataTable = h(
    'details',
    {},
    h('summary', {}, 'View data as a table'),
    h('div', { class: 'scroll' },
      h('table', {},
        h('thead', {}, h('tr', {}, tableHead.map((c, i) => h('th', { scope: 'col', class: i === 0 || (!amazonMode && i === 2) ? '' : 'num' }, c)))),
        h('tbody', {}, tableRows.map((row) => h('tr', {}, row.map((c, i) => h('td', { class: i === 0 || (!amazonMode && i === 2) ? '' : 'num' }, c))))),
      ),
    ),
  );

  panel.replaceChildren(
    h('div', { class: 'detail-head' },
      h('div', {},
        h('h2', {}, p.name),
        h('div', { class: 'muted' },
          `All-time low ${money(p.allTimeLow)} · high ${money(p.allTimeHigh)} · average store ${money(p.averageOffer)}`),
        p.lastError ? h('div', { class: 'muted up' }, `⚠ ${p.lastError}`) : null,
      ),
      h('div', { class: 'detail-actions' }, targetInput, saveBtn, refreshBtn, removeBtn),
    ),
    h('div', { class: 'controls' }, modeButtons, rangeButtons),
    amazonSummary,
    legend,
    chartBox,
    h('div', { class: 'offers' }, h('h3', {}, `Current offers (${p.offers.length})`), offerRows.length ? offerRows : h('p', { class: 'muted' }, 'No offers found yet.')),
    dataTable,
  );

  const series = amazonMode ? amazonSeries : [{ name: 'Best price', color: 'var(--series-1)', points: visible }];
  drawChart(chartBox, series, amazonMode ? null : p.targetPrice);
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

function drawChart(box, series, target) {
  const multi = series.length > 1;
  const all = series.flatMap((s) => s.points);
  if (!all.length || Math.max(...all.map((p) => p.t)) === Math.min(...all.map((p) => p.t))) {
    box.replaceChildren(h('p', { class: 'muted' }, 'Not enough history in this range yet. Prices are re-checked automatically.'));
    return;
  }
  const W = Math.max(box.clientWidth, 320), H = 280;
  const m = { top: 14, right: multi ? (W < 520 ? 84 : 150) : 16, bottom: 28, left: 56 };
  const prices = all.map((p) => p.price);
  let lo = Math.min(...prices), hi = Math.max(...prices);
  const showTarget = target != null && target >= lo * 0.6 && target <= hi * 1.4;
  if (showTarget) { lo = Math.min(lo, target); hi = Math.max(hi, target); }
  const ticks = niceTicks(lo, hi);
  const yMin = ticks[0], yMax = ticks.at(-1);
  const times = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
  const t0 = times[0], t1 = times.at(-1);
  const x = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * (W - m.left - m.right);
  const y = (v) => m.top + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - m.top - m.bottom);
  const text = (attrs, content) => Object.assign(svg('text', attrs), { textContent: content });

  const label = multi
    ? `Price over time for ${series.map((s) => s.name).join(', ')}`
    : `Best price over time for the selected product, from ${money(Math.min(...prices))} to ${money(Math.max(...prices))}`;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });

  for (const v of ticks) {
    root.append(
      svg('line', { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }),
      text({ x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end' }, money(v, 0)),
    );
  }
  const xTicks = W < 520 ? 2 : 4;
  for (let i = 0; i <= xTicks; i++) {
    const t = t0 + ((t1 - t0) * i) / xTicks;
    root.append(text({ x: x(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === xTicks ? 'end' : 'middle' }, dateShort(t)));
  }

  if (showTarget) {
    root.append(
      svg('line', { x1: m.left, x2: W - m.right, y1: y(target), y2: y(target), stroke: 'var(--text-muted)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }),
      text({ x: W - m.right, y: y(target) - 6, 'text-anchor': 'end' }, `Target ${money(target)}`),
    );
  }

  for (const s of series) {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.price).toFixed(1)}`).join('');
    root.append(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }

  const dotAt = (pt, color) =>
    svg('circle', { cx: x(pt.t), cy: y(pt.price), r: 4.5, fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2 });

  if (multi) {
    // Direct labels at each line's end, nudged apart so close prices don't overlap.
    const ends = series.map((s) => ({ s, pt: s.points.at(-1) })).sort((a, b) => y(a.pt.price) - y(b.pt.price));
    let prevY = -Infinity;
    for (const { s, pt } of ends) {
      const ly = Math.max(y(pt.price) + 4, prevY + 15);
      prevY = ly;
      root.append(dotAt(pt, s.color), text({ x: x(pt.t) + 10, y: ly, style: 'font-weight:600' }, `${W < 520 ? s.name.replace('Amazon', '') : s.name} ${money(pt.price, 0)}`));
    }
  } else {
    // Direct label on the low point and the latest point (not every point).
    const pts = series[0].points;
    const lowPt = pts.reduce((a, b) => (b.price < a.price ? b : a));
    const last = pts.at(-1);
    const mark = (pt, content, anchor) =>
      root.append(dotAt(pt, series[0].color), text({ x: x(pt.t), y: y(pt.price) + 20, 'text-anchor': anchor, style: 'font-weight:600' }, content));
    mark(lowPt, `Low ${money(lowPt.price)}`, x(lowPt.t) < m.left + 50 ? 'start' : x(lowPt.t) > W - m.right - 50 ? 'end' : 'middle');
    if (last !== lowPt) mark(last, `Now ${money(last.price)}`, 'end');
  }

  // Hover layer: crosshair + tooltip following the nearest snapshot.
  const cross = svg('line', { y1: m.top, y2: H - m.bottom, stroke: 'var(--text-muted)', 'stroke-width': 1, visibility: 'hidden' });
  const dots = series.map((s) => svg('circle', { r: 5.5, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' }));
  const hit = svg('rect', { x: m.left, y: m.top, width: W - m.left - m.right, height: H - m.top - m.bottom, fill: 'transparent' });
  root.append(cross, ...dots, hit);

  const tip = $('#tooltip');
  const show = (clientX, clientY) => {
    const rect = root.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    const t = times.reduce((a, b) => (Math.abs(x(b) - px) < Math.abs(x(a) - px) ? b : a));
    cross.setAttribute('x1', x(t)); cross.setAttribute('x2', x(t));
    cross.setAttribute('visibility', 'visible');

    const rows = [];
    series.forEach((s, i) => {
      const pt = s.points.find((p) => p.t === t);
      dots[i].setAttribute('visibility', pt ? 'visible' : 'hidden');
      if (!pt) return;
      dots[i].setAttribute('cx', x(t)); dots[i].setAttribute('cy', y(pt.price));
      rows.push({ s, pt });
    });
    rows.sort((a, b) => a.pt.price - b.pt.price);

    tip.replaceChildren(
      h('div', { class: 'muted' }, dateTime(t)),
      ...(multi
        ? rows.map(({ s, pt }) => h('div', {}, h('i', { class: 'swatch', style: `background:${s.color}` }), `${s.name} `, h('b', {}, money(pt.price))))
        : [h('div', {}, h('b', {}, money(rows[0].pt.price)), ` at ${rows[0].pt.store}`)]),
    );
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(clientX + 14, window.innerWidth - tw - 8)}px`;
    tip.style.top = `${clientY + 14}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
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
