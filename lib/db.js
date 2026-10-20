import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const MAX_SNAPSHOTS = 2000;

export class Db {
  constructor(file) {
    this.file = file;
    this.data = { products: [] };
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this;
  }

  // Writes are serialised and atomic (temp file + rename) so a crash mid-write
  // can't leave a truncated db.json behind.
  save() {
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data));
      await rename(tmp, this.file);
    });
    return this.queue;
  }

  get products() {
    return this.data.products;
  }

  find(id) {
    return this.products.find((p) => p.id === id);
  }
}
