import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DAY = 86_400_000;

export class BudgetError extends Error {}

// Start of the billing period containing `now`: the most recent `resetDay` (1-28) at 00:00 UTC.
export function periodStart(now, resetDay = 1) {
  const d = new Date(now);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth();
  if (d.getUTCDate() < resetDay) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  return Date.UTC(year, month, resetDay);
}

export function periodEnd(start, resetDay = 1) {
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, resetDay);
}

// Counts paid searches against a per-period allowance, persisted so restarts don't reset it.
export class Meter {
  constructor({ file, limit, resetDay = 1, now = Date.now }) {
    this.file = file;
    this.limit = limit;
    this.resetDay = resetDay;
    this.now = now;
    this.start = periodStart(now(), resetDay);
    this.used = 0;
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.periodStart === this.start) this.used = saved.used;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this;
  }

  roll() {
    const start = periodStart(this.now(), this.resetDay);
    if (start !== this.start) {
      this.start = start;
      this.used = 0;
    }
  }

  canAfford(n) {
    this.roll();
    return this.used + n <= this.limit;
  }

  exhaustedMessage() {
    return `Monthly search budget used up (${this.used}/${this.limit}); checks resume ${new Date(periodEnd(this.start, this.resetDay)).toLocaleDateString('en-GB', { timeZone: 'UTC' })}`;
  }

  use() {
    this.roll();
    if (this.used >= this.limit) throw new BudgetError(this.exhaustedMessage());
    this.used += 1;
    this.save();
  }

  save() {
    const body = JSON.stringify({ periodStart: this.start, used: this.used });
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.tmp`, body);
        await rename(`${this.file}.tmp`, this.file);
      })
      .catch((err) => console.error('Could not save search usage:', err.message));
    return this.queue;
  }

  snapshot() {
    this.roll();
    return {
      used: this.used,
      limit: this.limit,
      remaining: Math.max(0, this.limit - this.used),
      resetsAt: periodEnd(this.start, this.resetDay),
    };
  }
}

export const meteredFetch = (meter, fetchImpl = fetch) => (...args) => {
  meter.use();
  return fetchImpl(...args);
};

// How often each product can be refreshed so the allowance lasts the whole period,
// keeping 15% back for manual "Check now" clicks. Never faster than every 6 hours.
export function autoRefreshMs({ products, costPerRefresh, limit, periodMs = 30 * DAY }) {
  if (!costPerRefresh || products < 1) return 24 * 3_600_000;
  const refreshes = Math.floor((limit * 0.85) / (costPerRefresh * products));
  if (refreshes < 1) return Infinity;
  return Math.max(6 * 3_600_000, Math.round(periodMs / refreshes));
}
