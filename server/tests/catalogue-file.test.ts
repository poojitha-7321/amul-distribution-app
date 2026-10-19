import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { login, makeAdmin, resetDb } from './helpers.js';

describe('shipped Amul milk and curd catalogue file', () => {
  beforeEach(resetDb);

  it('imports cleanly through the admin import flow and creates no stock', async () => {
    await makeAdmin();
    await query("INSERT INTO categories (name) VALUES ('Milk'), ('Curd / Dahi')");
    const admin = await login('admin@test.local');
    const file = readFileSync(path.resolve(__dirname, '../../data/amul-milk-curd-catalogue.csv'));
    const parsed = await admin.post('/api/admin/imports/products/parse?mode=create_only').attach('file', file, 'amul.csv');
    expect(parsed.status).toBe(200);
    const bad = parsed.body.validated.filter((r: any) => r.errors.length);
    expect(bad).toEqual([]);
    const done = await admin.post('/api/admin/imports/products/commit').send({ rows: parsed.body.rows, mode: 'create_only' });
    expect(done.body.created).toBe(parsed.body.rows.length);
    const cats = await query<any>("SELECT c.name, count(*)::int AS n FROM variants v JOIN products p ON p.id = v.product_id JOIN categories c ON c.id = p.category_id GROUP BY c.name ORDER BY 1");
    expect(cats.map((c) => c.name)).toEqual(['Curd / Dahi', 'Milk']);
    const stock = await query<any>('SELECT sum(physical_stock)::int AS s FROM inventory');
    expect(stock[0].s).toBe(0);
  });
});
