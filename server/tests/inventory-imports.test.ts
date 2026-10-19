import { beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { query, queryOne } from '../src/db.js';
import { login, makeAdmin, makeRetailer, makeVariant, placeOrder, resetDb, stock } from './helpers.js';

let admin: Awaited<ReturnType<typeof login>>;
let shopA: Awaited<ReturnType<typeof login>>;

beforeEach(async () => {
  await resetDb();
  await makeAdmin();
  await makeRetailer('Shop A', 'a@test.local');
  admin = await login('admin@test.local');
  shopA = await login('a@test.local');
});

describe('manual stock adjustments', () => {
  it('requires a reason and records an audit trail', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 50 });
    expect((await admin.post(`/api/admin/inventory/${v}/adjust`).send({ newStock: 40, reason: '' })).status).toBe(400);
    expect((await admin.post(`/api/admin/inventory/${v}/adjust`).send({ newStock: -1, reason: 'typo' })).status).toBe(400);
    expect((await admin.post(`/api/admin/inventory/${v}/adjust`).send({ newStock: 40, reason: 'Stock-take: 10 packets leaked' })).status).toBe(200);
    expect(await stock(v)).toMatchObject({ physical_stock: 40 });
    const tx = await queryOne<any>("SELECT * FROM inventory_transactions WHERE type = 'ADJUSTMENT'");
    expect(tx).toMatchObject({ physical_delta: -10, physical_after: 40, reason: 'Stock-take: 10 packets leaked' });
    expect(tx.user_id).not.toBeNull();
    const audit = await queryOne<any>("SELECT details FROM audit_logs WHERE action = 'stock.adjust'");
    expect(audit.details).toMatchObject({ from: 50, to: 40 });
  });

  it('cannot reduce stock below what is reserved for accepted orders', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 50 });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 30 }]);
    await admin.post(`/api/orders/${o.body.id}/accept`).send({});
    const r = await admin.post(`/api/admin/inventory/${v}/adjust`).send({ newStock: 20, reason: 'recount' });
    expect(r.status).toBe(409);
    expect(await stock(v)).toMatchObject({ physical_stock: 50, reserved_stock: 30 });
    expect((await admin.post(`/api/admin/inventory/${v}/adjust`).send({ newStock: 30, reason: 'recount' })).status).toBe(200);
  });

  it('records returned and damaged goods separately', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 50 });
    const post = (b: object) => admin.post('/api/admin/inventory/returns').send({ variantId: v, reason: 'test reason', ...b });
    expect((await post({ kind: 'RETURN', quantity: 5 })).status).toBe(201); // resellable return: +5
    expect((await post({ kind: 'RETURN_DAMAGED', quantity: 3 })).status).toBe(201); // damaged return: no stock change
    expect((await post({ kind: 'DAMAGED', quantity: 2 })).status).toBe(201); // warehouse damage: -2
    expect(await stock(v)).toMatchObject({ physical_stock: 53 });
    expect((await post({ kind: 'DAMAGED', quantity: 500 })).status).toBe(409); // cannot go negative
    expect((await post({ kind: 'DAMAGED', quantity: 0 })).status).toBe(400);
    expect(await stock(v)).toMatchObject({ physical_stock: 53 });
    const report = await admin.get('/api/admin/reports/returns-damaged');
    expect(report.body.rows.map((r: any) => r.type).sort()).toEqual(['DAMAGED', 'RETURN', 'RETURN_DAMAGED']);
  });

  it('lists the movement history with filters', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 50 });
    await admin.post(`/api/admin/inventory/${v}/adjust`).send({ newStock: 45, reason: 'recount' });
    const res = await admin.get(`/api/admin/inventory/transactions?variantId=${v}&type=ADJUSTMENT`);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].user_name).toBe('Admin');
  });
});

describe('product catalogue management', () => {
  it('creates products and variants with opening stock, rejecting duplicate SKUs', async () => {
    const cat = await queryOne<any>("INSERT INTO categories (name) VALUES ('Milk') RETURNING id");
    const p = await admin.post('/api/admin/products').send({ categoryId: cat.id, name: 'Amul Gold' });
    expect(p.status).toBe(201);
    const body = {
      variantName: '500 ml pouch', sku: 'GOLD-500', packSize: 500, packSizeUnit: 'ml', stockUnit: 'packet',
      unitsPerCrate: 24, defaultOrderUnit: 'crate', price: 34, minStock: 20, openingStock: 240,
    };
    const v = await admin.post(`/api/admin/products/${p.body.id}/variants`).send(body);
    expect(v.status).toBe(201);
    expect(await stock(v.body.id)).toMatchObject({ physical_stock: 240 });
    expect((await admin.post(`/api/admin/products/${p.body.id}/variants`).send({ ...body, sku: 'gold-500' })).status).toBe(409);
    // crate default without a crate size is invalid
    expect((await admin.post(`/api/admin/products/${p.body.id}/variants`).send({ ...body, sku: 'X-1', unitsPerCrate: null })).status).toBe(400);
    // editing a variant never changes stock
    const upd = await admin.put(`/api/admin/variants/${v.body.id}`).send({ ...body, price: 36, minStock: 30, openingStock: 9999 });
    expect(upd.status).toBe(200);
    expect(await stock(v.body.id)).toMatchObject({ physical_stock: 240 });
    // deactivating hides it from retailers
    await admin.patch(`/api/admin/variants/${v.body.id}/active`).send({ active: false });
    expect((await shopA.get('/api/catalog')).body.products).toHaveLength(0);
  });
});

const header = 'category,product_name,brand,variant_name,pack_size,pack_size_unit,stock_unit,units_per_crate,default_order_unit,sku,price,crate_price,min_stock,active';
const csv = (...lines: string[]) => Buffer.from([header, ...lines].join('\n'));

describe('product import', () => {
  beforeEach(async () => {
    await query("INSERT INTO categories (name) VALUES ('Milk'), ('Curd / Dahi')");
  });

  it('previews rows, flagging missing fields, bad units and duplicate SKUs', async () => {
    const file = csv(
      'Milk,Amul Taaza,Amul,500 ml pouch,500,ml,packet,24,crate,TAAZA-500,27,,48,yes',
      'Milk,Amul Taaza,Amul,500 ml pouch,500,ml,packet,24,crate,taaza-500,27,,48,yes', // duplicate in file
      'Curd / Dahi,Amul Masti Dahi,Amul,400 g,400,gallon,packet,,packet,DAHI-400,35,,24,yes', // bad unit
      'Cheese,Amul Cheese,Amul,200 g,200,g,packet,,packet,CHZ-200,100,,5,yes', // unknown category
      'Milk,,Amul,1 L,1,l,packet,,packet,,50,,5,yes', // missing name + sku
    );
    const res = await admin.post('/api/admin/imports/products/parse?mode=create_only').attach('file', file, 'products.csv');
    expect(res.status).toBe(200);
    const v = res.body.validated;
    expect(v[0].errors).toEqual([]);
    expect(v[1].errors.join()).toMatch(/Duplicate SKU/);
    expect(v[2].errors.join()).toMatch(/Invalid pack_size_unit/);
    expect(v[3].errors.join()).toMatch(/Unknown category/);
    expect(v[4].errors.join()).toMatch(/product_name is required/);
    expect(v[4].errors.join()).toMatch(/sku is required/);
  });

  it('imports valid rows, skips invalid ones, and never creates stock', async () => {
    const rows = [
      { category: 'Milk', product_name: 'Amul Taaza', variant_name: '500 ml', pack_size: '500', pack_size_unit: 'ml', sku: 'TAAZA-500', price: '27', min_stock: '48', units_per_crate: '24', default_order_unit: 'crate' },
      { category: 'Milk', product_name: 'Amul Taaza', variant_name: '1 L', pack_size: '1', pack_size_unit: 'l', sku: 'TAAZA-1L', price: '54' },
      { category: 'Milk', product_name: 'Bad', variant_name: 'x', pack_size: '-1', pack_size_unit: 'ml', sku: 'BAD-1' },
    ];
    const r = await admin.post('/api/admin/imports/products/commit').send({ rows, mode: 'create_only' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 2, updated: 0, skipped: 1 });
    expect((await query('SELECT id FROM products')).length).toBe(1); // both variants share one product
    const inv = await query<any>('SELECT physical_stock, min_stock FROM inventory ORDER BY variant_id');
    expect(inv.map((i) => i.physical_stock)).toEqual([0, 0]);
    expect(inv[0].min_stock).toBe(48);
  });

  it('does not overwrite existing products or stock unless "update existing" is chosen, and still keeps stock', async () => {
    const v = await makeVariant({ sku: 'TAAZA-500', stock: 77, price: 20 });
    const rows = [{ category: 'Milk', product_name: 'Amul Taaza', variant_name: '500 ml', pack_size: '500', pack_size_unit: 'ml', sku: 'TAAZA-500', price: '30' }];
    const blocked = await admin.post('/api/admin/imports/products/commit').send({ rows, mode: 'create_only' });
    expect(blocked.body).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(blocked.body.rows[0].errors.join()).toMatch(/already exists/);
    const upd = await admin.post('/api/admin/imports/products/commit').send({ rows, mode: 'update_existing' });
    expect(upd.body).toMatchObject({ updated: 1 });
    expect((await queryOne<any>('SELECT price FROM variants WHERE id = $1', [v]))!.price).toBe(30);
    expect(await stock(v)).toMatchObject({ physical_stock: 77 });
  });

  it('reads Excel files and offers CSV and Excel templates', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Products');
    ws.addRow(header.split(','));
    ws.addRow(['Milk', 'Amul Gold', 'Amul', '500 ml', 500, 'ml', 'packet', 24, 'crate', 'GOLD-500', 34, '', 20, 'yes']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await admin.post('/api/admin/imports/products/parse?mode=create_only').attach('file', buf, 'p.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.validated[0].errors).toEqual([]);
    expect(res.body.validated[0].data.sku).toBe('GOLD-500');
    const t1 = await admin.get('/api/admin/imports/products/template?format=csv');
    expect(t1.text).toContain('category,product_name');
    const t2 = await admin.get('/api/admin/imports/stock/template?format=xlsx').buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect((t2.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    expect((await admin.post('/api/admin/imports/products/parse').attach('file', Buffer.from('x'), 'bad.txt')).status).toBe(400);
  });
});

describe('stock import', () => {
  it('requires explicit confirmation and a reason, applies atomically, and writes an audit log', async () => {
    const a = await makeVariant({ sku: 'S-1', stock: 10 });
    const b = await makeVariant({ sku: 'S-2', stock: 20 });
    const rows = [{ sku: 'S-1', quantity: '15' }, { sku: 'S-2', quantity: '5' }];
    expect((await admin.post('/api/admin/imports/stock/commit').send({ rows, mode: 'adjustment', reason: 'Stock take' })).status).toBe(400); // no confirm
    expect((await admin.post('/api/admin/imports/stock/commit').send({ rows, mode: 'adjustment', reason: '', confirm: true })).status).toBe(400);
    const bad = await admin.post('/api/admin/imports/stock/commit').send({ rows: [...rows, { sku: 'NOPE', quantity: '1' }], mode: 'adjustment', reason: 'Stock take', confirm: true });
    expect(bad.status).toBe(400);
    expect(await stock(a)).toMatchObject({ physical_stock: 10 }); // nothing applied
    const ok = await admin.post('/api/admin/imports/stock/commit').send({ rows, mode: 'adjustment', reason: 'Stock take', confirm: true });
    expect(ok.status).toBe(200);
    expect(await stock(a)).toMatchObject({ physical_stock: 15 });
    expect(await stock(b)).toMatchObject({ physical_stock: 5 });
    expect((await queryOne<any>("SELECT count(*) AS n FROM audit_logs WHERE action = 'import.stock'"))!.n).toBe(1);
    expect((await query("SELECT id FROM inventory_transactions WHERE type = 'ADJUSTMENT'")).length).toBe(2);
  });

  it('shows current vs new quantities in the preview and blocks values below reserved stock', async () => {
    const v = await makeVariant({ sku: 'S-1', stock: 50 });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 30 }]);
    await admin.post(`/api/orders/${o.body.id}/accept`).send({});
    const res = await admin.post('/api/admin/imports/stock/validate').send({ rows: [{ sku: 'S-1', quantity: '10' }], mode: 'adjustment' });
    expect(res.body.validated[0]).toMatchObject({ currentStock: 50, newStock: 10, delta: -40 });
    expect(res.body.validated[0].errors.join()).toMatch(/reserved/);
  });

  it('allows opening stock only before any stock movement', async () => {
    await query("INSERT INTO categories (name) VALUES ('Milk')");
    await admin.post('/api/admin/imports/products/commit').send({
      rows: [{ category: 'Milk', product_name: 'Amul Taaza', variant_name: '500 ml', pack_size: '500', pack_size_unit: 'ml', sku: 'NEW-1' }], mode: 'create_only' });
    const first = await admin.post('/api/admin/imports/stock/commit').send({ rows: [{ sku: 'NEW-1', quantity: '100' }], mode: 'opening', reason: 'Initial load', confirm: true });
    expect(first.status).toBe(200);
    const inv = await queryOne<any>("SELECT opening_stock, physical_stock FROM inventory i JOIN variants v ON v.id = i.variant_id WHERE v.sku = 'NEW-1'");
    expect(inv).toMatchObject({ opening_stock: 100, physical_stock: 100 });
    const again = await admin.post('/api/admin/imports/stock/commit').send({ rows: [{ sku: 'NEW-1', quantity: '120' }], mode: 'opening', reason: 'Again', confirm: true });
    expect(again.status).toBe(400);
  });
});

describe('reports and exports', () => {
  it('runs every report, filters by retailer, and exports CSV and Excel', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 100, price: 10 });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 10 }]);
    for (const a of ['accept', 'prepare', 'ready', 'deliver']) await admin.post(`/api/orders/${o.body.id}/${a}`).send({});
    const list = await admin.get('/api/admin/reports');
    expect(list.body.reports.length).toBe(10);
    for (const r of list.body.reports) {
      const res = await admin.get(`/api/admin/reports/${r.name}`);
      expect(res.status, r.name).toBe(200);
      expect(res.body.columns.length).toBeGreaterThan(0);
    }
    const retailer = await admin.get('/api/admin/reports/retailer-orders');
    expect(retailer.body.rows[0]).toMatchObject({ retailer: 'Shop A', orders: 1, delivered: 1, delivered_amount: 100 });
    const delivered = await admin.get('/api/admin/reports/product-delivered');
    expect(delivered.body.rows[0]).toMatchObject({ ordered_units: 10, delivered_units: 10, short_units: 0 });
    const csvRes = await admin.get('/api/admin/reports/current-stock?format=csv');
    expect(csvRes.headers['content-type']).toMatch(/text\/csv/);
    expect(csvRes.text).toContain('Physical');
    const xlsx = await admin.get('/api/admin/reports/current-stock?format=xlsx').buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    expect((await admin.get('/api/admin/reports/nope')).status).toBe(400);
  });

  it('neutralises spreadsheet formulas in exports', async () => {
    const v = await makeVariant({ sku: 'M-1', name: '=HYPERLINK("http://evil")' });
    expect(v).toBeGreaterThan(0);
    const csvRes = await admin.get('/api/admin/reports/current-stock?format=csv');
    expect(csvRes.text).toContain("'=HYPERLINK");
  });
});
