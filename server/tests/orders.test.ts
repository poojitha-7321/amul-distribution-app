import { beforeEach, describe, expect, it } from 'vitest';
import { pool, query, queryOne } from '../src/db.js';
import { login, makeAdmin, makeRetailer, makeVariant, placeOrder, resetDb, stock, tomorrow } from './helpers.js';
import { todayStr } from '../src/lib.js';

let admin: Awaited<ReturnType<typeof login>>;
let shopA: Awaited<ReturnType<typeof login>>;
let shopB: Awaited<ReturnType<typeof login>>;

beforeEach(async () => {
  await resetDb();
  await makeAdmin();
  await makeRetailer('Shop A', 'a@test.local');
  await makeRetailer('Shop B', 'b@test.local');
  admin = await login('admin@test.local');
  shopA = await login('a@test.local');
  shopB = await login('b@test.local');
});

const act = (id: number, action: string, body: object = {}) => admin.post(`/api/orders/${id}/${action}`).send(body);
async function toReady(id: number) {
  expect((await act(id, 'accept')).status).toBe(200);
  expect((await act(id, 'prepare')).status).toBe(200);
  expect((await act(id, 'ready')).status).toBe(200);
}

describe('order creation and validation', () => {
  it('creates an order with a server-calculated total and order number', async () => {
    const v = await makeVariant({ sku: 'M-1', price: 27 });
    const res = await placeOrder(shopA, [{ variantId: v, quantity: 10 }]);
    expect(res.status).toBe(201);
    const detail = await shopA.get(`/api/orders/${res.body.id}`);
    expect(detail.body.order.status).toBe('SUBMITTED');
    expect(detail.body.order.order_number).toMatch(/^ORD-\d{8}-\d+$/);
    expect(detail.body.order.total_amount).toBe(270);
    expect(detail.body.items[0].line_total).toBe(270);
    expect(detail.body.history).toHaveLength(1);
  });

  it('ignores any price or total sent by the browser', async () => {
    const v = await makeVariant({ sku: 'M-1', price: 27 });
    const res = await shopA.post('/api/orders').send({
      deliveryDate: tomorrow(), total: 1, totalAmount: 1,
      items: [{ variantId: v, unit: 'packet', quantity: 2, price: 0.01, unitPrice: 0.01 }],
    });
    expect(res.status).toBe(201);
    const o = await queryOne<any>('SELECT total_amount FROM orders WHERE id = $1', [res.body.id]);
    expect(o.total_amount).toBe(54);
  });

  it.each([
    ['zero quantity', { quantity: 0 }],
    ['negative quantity', { quantity: -3 }],
    ['fractional quantity', { quantity: 1.5 }],
    ['absurd quantity', { quantity: 10_000_000 }],
    ['unknown unit', { quantity: 1, unit: 'tonne' }],
  ])('rejects %s', async (_name, patch) => {
    const v = await makeVariant({ sku: 'M-1' });
    const res = await shopA.post('/api/orders').send({
      deliveryDate: tomorrow(),
      items: [{ variantId: v, unit: 'packet', quantity: 1, ...patch }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty orders, past dates and dates beyond the booking window', async () => {
    const v = await makeVariant({ sku: 'M-1' });
    expect((await shopA.post('/api/orders').send({ deliveryDate: tomorrow(), items: [] })).status).toBe(400);
    expect((await placeOrder(shopA, [{ variantId: v, quantity: 1 }], { deliveryDate: todayStr() })).status).toBe(400);
    expect((await placeOrder(shopA, [{ variantId: v, quantity: 1 }], { deliveryDate: todayStr(-3) })).status).toBe(400);
    expect((await placeOrder(shopA, [{ variantId: v, quantity: 1 }], { deliveryDate: todayStr(60) })).status).toBe(400);
  });

  it('rejects inactive or unknown products and crates for variants without a crate size', async () => {
    const inactive = await makeVariant({ sku: 'M-OFF' });
    await pool.query('UPDATE variants SET active = FALSE WHERE id = $1', [inactive]);
    expect((await placeOrder(shopA, [{ variantId: inactive, quantity: 1 }])).status).toBe(400);
    expect((await placeOrder(shopA, [{ variantId: 99999, quantity: 1 }])).status).toBe(400);
    const nocrate = await makeVariant({ sku: 'M-NC', crate: null });
    expect((await placeOrder(shopA, [{ variantId: nocrate, unit: 'crate', quantity: 1 }])).status).toBe(400);
  });

  it('is idempotent: a double-tap with the same token creates one order', async () => {
    const v = await makeVariant({ sku: 'M-1' });
    const body = { submitToken: 'token-12345678' };
    const [r1, r2] = await Promise.all([
      placeOrder(shopA, [{ variantId: v, quantity: 3 }], body),
      placeOrder(shopA, [{ variantId: v, quantity: 3 }], body),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(r1.body.id).toBe(r2.body.id);
    expect((await query('SELECT id FROM orders')).length).toBe(1);
  });

  it('refuses orders larger than available stock under the default "block" policy', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 10 });
    const res = await placeOrder(shopA, [{ variantId: v, quantity: 11 }]);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/only 10 packet available/);
    expect((await query('SELECT id FROM orders')).length).toBe(0);
  });

  it('converts crates to stock units using the configured crate size', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 100, crate: 24, price: 10 });
    const res = await placeOrder(shopA, [{ variantId: v, unit: 'crate', quantity: 2 }]);
    expect(res.status).toBe(201);
    const item = (await shopA.get(`/api/orders/${res.body.id}`)).body.items[0];
    expect(item.base_quantity).toBe(48);
    expect(item.unit_price).toBe(240); // 24 x 10
    expect(item.line_total).toBe(480);
    await act(res.body.id, 'accept');
    expect(await stock(v)).toMatchObject({ physical_stock: 100, reserved_stock: 48 });
    // different crate sizes per product are honoured
    const v2 = await makeVariant({ sku: 'M-2', stock: 100, crate: 10 });
    const r2 = await placeOrder(shopA, [{ variantId: v2, unit: 'crate', quantity: 3 }]);
    expect((await shopA.get(`/api/orders/${r2.body.id}`)).body.items[0].base_quantity).toBe(30);
  });

  it('keeps historical orders unchanged when product details change later', async () => {
    const v = await makeVariant({ sku: 'M-1', name: 'Amul Taaza', price: 27 });
    const res = await placeOrder(shopA, [{ variantId: v, quantity: 4 }]);
    await pool.query("UPDATE variants SET price = 99, variant_name = 'Renamed', sku = 'M-1-NEW' WHERE id = $1", [v]);
    await pool.query("UPDATE products SET name = 'Something else' WHERE id = (SELECT product_id FROM variants WHERE id = $1)", [v]);
    const item = (await shopA.get(`/api/orders/${res.body.id}`)).body.items[0];
    expect(item).toMatchObject({ product_name: 'Amul Taaza', variant_name: '500 ml pouch', sku: 'M-1', unit_price: 27, line_total: 108 });
  });

  it('handles products with no price (pricing optional)', async () => {
    const v = await makeVariant({ sku: 'M-1', price: null });
    const res = await placeOrder(shopA, [{ variantId: v, quantity: 4 }]);
    expect(res.status).toBe(201);
    expect((await shopA.get(`/api/orders/${res.body.id}`)).body.order.total_amount).toBeNull();
  });
});

describe('stock reservation and delivery', () => {
  it('does not touch stock on submit, reserves on accept, and deducts only on delivery', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 100 });
    const a = await placeOrder(shopA, [{ variantId: v, quantity: 20 }]);
    const b = await placeOrder(shopB, [{ variantId: v, quantity: 10 }]);
    expect(await stock(v)).toMatchObject({ physical_stock: 100, reserved_stock: 0 });

    await act(a.body.id, 'accept');
    await act(b.body.id, 'accept');
    expect(await stock(v)).toMatchObject({ physical_stock: 100, reserved_stock: 30 });

    const cat = await shopA.get('/api/catalog');
    expect(cat.body.products[0].variants[0].available).toBe(70);
  });

  it('full delivery deducts the ordered quantity and releases the reservation', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 100 });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 20 }]);
    await act(o.body.id, 'accept');
    await act(o.body.id, 'prepare');
    await act(o.body.id, 'ready');
    const d = await act(o.body.id, 'deliver');
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('DELIVERED');
    expect(await stock(v)).toMatchObject({ physical_stock: 80, reserved_stock: 0 });
    const detail = await shopA.get(`/api/orders/${o.body.id}`);
    expect(detail.body.items[0].delivered_quantity).toBe(20);
    expect(detail.body.order.status).toBe('DELIVERED');
  });

  it('partial delivery (20 ordered, 18 delivered) deducts 18 and releases the other 2', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 100, price: 10 });
    const a = await placeOrder(shopA, [{ variantId: v, quantity: 20 }]);
    const b = await placeOrder(shopB, [{ variantId: v, quantity: 10 }]);
    await act(a.body.id, 'accept');
    await act(b.body.id, 'accept');
    await act(a.body.id, 'prepare');
    await act(a.body.id, 'ready');
    const itemId = (await shopA.get(`/api/orders/${a.body.id}`)).body.items[0].id;
    const d = await act(a.body.id, 'deliver', { items: [{ orderItemId: itemId, deliveredQuantity: 18 }], note: 'Short supply' });
    expect(d.body.status).toBe('PARTIALLY_DELIVERED');
    expect(await stock(v)).toMatchObject({ physical_stock: 82, reserved_stock: 10 }); // B's 10 stay reserved
    const detail = await shopA.get(`/api/orders/${a.body.id}`);
    expect(detail.body.order.delivered_amount).toBe(180);
    expect(detail.body.items[0]).toMatchObject({ quantity: 20, delivered_quantity: 18 });
    const tx = await query<any>('SELECT type, physical_delta, reserved_delta FROM inventory_transactions WHERE order_id = $1 ORDER BY id', [a.body.id]);
    expect(tx.map((t) => t.type)).toEqual(['RESERVE', 'DELIVERY', 'RELEASE']);
    expect(tx[1]).toMatchObject({ physical_delta: -18, reserved_delta: -18 });
    expect(tx[2]).toMatchObject({ physical_delta: 0, reserved_delta: -2 });
  });

  it('refuses to deliver more than ordered, or to skip items', async () => {
    const v = await makeVariant({ sku: 'M-1' });
    const v2 = await makeVariant({ sku: 'M-2' });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 5 }, { variantId: v2, quantity: 5 }]);
    await toReady(o.body.id);
    const items = (await shopA.get(`/api/orders/${o.body.id}`)).body.items;
    expect((await act(o.body.id, 'deliver', { items: [{ orderItemId: items[0].id, deliveredQuantity: 6 }, { orderItemId: items[1].id, deliveredQuantity: 5 }] })).status).toBe(400);
    expect((await act(o.body.id, 'deliver', { items: [{ orderItemId: items[0].id, deliveredQuantity: 5 }] })).status).toBe(400);
    expect((await act(o.body.id, 'deliver', { items: items.map((i: any) => ({ orderItemId: i.id, deliveredQuantity: 0 })) })).status).toBe(400);
    expect(await stock(v)).toMatchObject({ physical_stock: 100, reserved_stock: 5 }); // unchanged by failures
  });

  it('prevents duplicate delivery confirmation and double stock deduction', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 100 });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 20 }]);
    await toReady(o.body.id);
    expect((await act(o.body.id, 'deliver')).status).toBe(200);
    expect((await act(o.body.id, 'deliver')).status).toBe(409);
    expect((await act(o.body.id, 'deliver')).status).toBe(409);
    expect(await stock(v)).toMatchObject({ physical_stock: 80, reserved_stock: 0 });
    expect((await query('SELECT id FROM deliveries')).length).toBe(1);
  });

  it('only one of many simultaneous delivery confirmations succeeds', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 100 });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 20 }]);
    await toReady(o.body.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => act(o.body.id, 'deliver')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await stock(v)).toMatchObject({ physical_stock: 80, reserved_stock: 0 });
  });

  it('cannot deliver an order that is not ready', async () => {
    const v = await makeVariant({ sku: 'M-1' });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 5 }]);
    expect((await act(o.body.id, 'deliver')).status).toBe(409);
    await act(o.body.id, 'accept');
    expect((await act(o.body.id, 'deliver')).status).toBe(409);
  });

  it('enforces the lifecycle order of statuses', async () => {
    const v = await makeVariant({ sku: 'M-1' });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 5 }]);
    expect((await act(o.body.id, 'prepare')).status).toBe(409);
    expect((await act(o.body.id, 'ready')).status).toBe(409);
    await act(o.body.id, 'accept');
    expect((await act(o.body.id, 'accept')).status).toBe(409);
    expect((await act(o.body.id, 'reject')).status).toBe(409);
    const history = (await admin.get(`/api/orders/${o.body.id}`)).body.history;
    expect(history.map((h: any) => h.to_status)).toEqual(['SUBMITTED', 'ACCEPTED']);
    expect(history[1].user_name).toBe('Admin');
  });
});

describe('cancellation and rejection', () => {
  it('releases reserved stock when a retailer cancels an accepted order', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 50 });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 20 }]);
    await act(o.body.id, 'accept');
    expect(await stock(v)).toMatchObject({ reserved_stock: 20 });
    const c = await shopA.post(`/api/orders/${o.body.id}/cancel`).send({});
    expect(c.status).toBe(200);
    expect(await stock(v)).toMatchObject({ physical_stock: 50, reserved_stock: 0 });
    expect((await shopA.get(`/api/orders/${o.body.id}`)).body.order.status).toBe('CANCELLED');
    // cancelling twice is rejected and does not release twice
    expect((await shopA.post(`/api/orders/${o.body.id}/cancel`).send({})).status).toBe(409);
    expect(await stock(v)).toMatchObject({ reserved_stock: 0 });
  });

  it('stops retailer cancellation once the order is being prepared', async () => {
    const v = await makeVariant({ sku: 'M-1' });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 5 }]);
    await act(o.body.id, 'accept');
    await act(o.body.id, 'prepare');
    expect((await shopA.post(`/api/orders/${o.body.id}/cancel`).send({})).status).toBe(409);
    expect((await act(o.body.id, 'cancel')).status).toBe(200); // distributor still can
    expect(await stock(v)).toMatchObject({ reserved_stock: 0 });
  });

  it('honours the "cancel only while submitted" setting', async () => {
    await pool.query("UPDATE settings SET value = 'SUBMITTED' WHERE key = 'retailer_cancel_until'");
    const v = await makeVariant({ sku: 'M-1' });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 5 }]);
    await act(o.body.id, 'accept');
    expect((await shopA.post(`/api/orders/${o.body.id}/cancel`).send({})).status).toBe(409);
  });

  it('rejects a submitted order without reserving anything', async () => {
    const v = await makeVariant({ sku: 'M-1' });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 5 }]);
    expect((await act(o.body.id, 'reject', { note: 'Out of area' })).status).toBe(200);
    expect(await stock(v)).toMatchObject({ reserved_stock: 0 });
    const detail = await shopA.get(`/api/orders/${o.body.id}`);
    expect(detail.body.order.status).toBe('REJECTED');
    expect(detail.body.history.at(-1).note).toBe('Out of area');
  });
});

describe('consistency and concurrency', () => {
  it('never oversells when simultaneous orders compete for the last stock', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 10 });
    await pool.query("UPDATE settings SET value = 'partial' WHERE key = 'insufficient_stock_policy'"); // allow submitting
    const ids: number[] = [];
    for (const shop of [shopA, shopB, shopA, shopB, shopA, shopB]) {
      const r = await placeOrder(shop, [{ variantId: v, quantity: 4 }]);
      expect(r.status).toBe(201);
      ids.push(r.body.id);
    }
    await pool.query("UPDATE settings SET value = 'block' WHERE key = 'insufficient_stock_policy'");
    const results = await Promise.all(ids.map((id) => act(id, 'accept')));
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBe(2); // 10 units / 4 per order
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const s = await stock(v);
    expect(s.reserved_stock).toBe(8);
    expect(s.reserved_stock).toBeLessThanOrEqual(s.physical_stock);
  });

  it('leaves no partial reservation when a multi-item accept fails', async () => {
    const plenty = await makeVariant({ sku: 'M-1', stock: 100 });
    const scarce = await makeVariant({ sku: 'M-2', stock: 10 });
    await pool.query("UPDATE settings SET value = 'partial' WHERE key = 'insufficient_stock_policy'");
    const o = await placeOrder(shopA, [{ variantId: plenty, quantity: 50 }, { variantId: scarce, quantity: 50 }]);
    await pool.query("UPDATE settings SET value = 'block' WHERE key = 'insufficient_stock_policy'");
    const r = await act(o.body.id, 'accept');
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Not enough stock/);
    expect(await stock(plenty)).toMatchObject({ reserved_stock: 0 });
    expect(await stock(scarce)).toMatchObject({ reserved_stock: 0 });
    expect((await shopA.get(`/api/orders/${o.body.id}`)).body.order.status).toBe('SUBMITTED');
    expect((await query('SELECT id FROM inventory_transactions WHERE type = $1', ['RESERVE'])).length).toBe(0);
  });

  it('"partial" policy reserves what is available and records the shortfall', async () => {
    await pool.query("UPDATE settings SET value = 'partial' WHERE key = 'insufficient_stock_policy'");
    const v = await makeVariant({ sku: 'M-1', stock: 30 });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 50 }]);
    expect(o.status).toBe(201);
    const r = await act(o.body.id, 'accept');
    expect(r.status).toBe(200);
    expect(r.body.shortages[0]).toMatchObject({ requested: 50, available: 30 });
    expect(await stock(v)).toMatchObject({ physical_stock: 30, reserved_stock: 30 });
    await act(o.body.id, 'prepare');
    await act(o.body.id, 'ready');
    const d = await act(o.body.id, 'deliver', { items: [{ orderItemId: (await shopA.get(`/api/orders/${o.body.id}`)).body.items[0].id, deliveredQuantity: 30 }] });
    expect(d.body.status).toBe('PARTIALLY_DELIVERED');
    expect(await stock(v)).toMatchObject({ physical_stock: 0, reserved_stock: 0 });
  });

  it('every stock change is recorded and balances to the current stock', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 100 });
    // The fixture inserts stock directly, so record the opening movement the way the app does.
    await pool.query("INSERT INTO inventory_transactions (variant_id, type, physical_delta, physical_after, reserved_after, quantity) VALUES ($1,'OPENING',100,100,0,100)", [v]);
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 20 }]);
    await toReady(o.body.id);
    await act(o.body.id, 'deliver', { items: [{ orderItemId: (await shopA.get(`/api/orders/${o.body.id}`)).body.items[0].id, deliveredQuantity: 15 }] });
    const sums = await queryOne<any>('SELECT sum(physical_delta) AS p, sum(reserved_delta) AS r FROM inventory_transactions WHERE variant_id = $1', [v]);
    const s = await stock(v);
    expect(Number(sums.p)).toBe(s.physical_stock);
    expect(Number(sums.r)).toBe(s.reserved_stock);
  });

  it('writes audit log entries for deliveries and order actions', async () => {
    const v = await makeVariant({ sku: 'M-1' });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 2 }]);
    await toReady(o.body.id);
    await act(o.body.id, 'deliver');
    const actions = (await query<any>('SELECT action FROM audit_logs ORDER BY id')).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['order.create', 'order.accept', 'order.ready', 'order.deliver']));
  });

  it('notifies the distributor of new orders and the retailer of status changes', async () => {
    const v = await makeVariant({ sku: 'M-1' });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 2 }]);
    const adminNotes = await admin.get('/api/notifications');
    expect(adminNotes.body.unread).toBe(1);
    expect(adminNotes.body.notifications[0].title).toMatch(/New order/);
    await act(o.body.id, 'accept');
    const retailerNotes = await shopA.get('/api/notifications');
    expect(retailerNotes.body.notifications[0].title).toMatch(/accepted/);
    expect((await shopB.get('/api/notifications')).body.notifications).toHaveLength(0);
    await admin.post('/api/notifications/read-all').send({});
    expect((await admin.get('/api/notifications')).body.unread).toBe(0);
  });

  it('raises a low-stock alert when available stock falls below the minimum', async () => {
    const v = await makeVariant({ sku: 'M-1', stock: 50, min: 40 });
    const o = await placeOrder(shopA, [{ variantId: v, quantity: 20 }]);
    await act(o.body.id, 'accept');
    const notes = (await admin.get('/api/notifications')).body.notifications.map((n: any) => n.title);
    expect(notes).toContain('Low stock');
    const dash = await admin.get('/api/dashboard/admin');
    expect(dash.body.cards.low_stock).toBe(1);
  });
});

describe('repeat order and retailer views', () => {
  it('rebuilds a cart from a previous order, skipping products that are no longer sold', async () => {
    const v1 = await makeVariant({ sku: 'M-1' });
    const v2 = await makeVariant({ sku: 'M-2' });
    const o = await placeOrder(shopA, [{ variantId: v1, quantity: 5 }, { variantId: v2, unit: 'crate', quantity: 2 }]);
    await pool.query('UPDATE variants SET active = FALSE WHERE id = $1', [v2]);
    const r = await shopA.get(`/api/orders/${o.body.id}/reorder`);
    expect(r.body.lines).toEqual([{ variantId: v1, unit: 'packet', quantity: 5 }]);
    expect(r.body.skipped).toHaveLength(1);
    expect((await shopB.get(`/api/orders/${o.body.id}/reorder`)).status).toBe(404);
  });

  it('hides inactive products from retailers but not from the distributor', async () => {
    const v = await makeVariant({ sku: 'M-1' });
    await pool.query('UPDATE variants SET active = FALSE WHERE id = $1', [v]);
    expect((await shopA.get('/api/catalog')).body.products).toHaveLength(0);
    expect((await admin.get('/api/admin/products')).body.products).toHaveLength(1);
  });

  it('filters the distributor order list', async () => {
    const v = await makeVariant({ sku: 'M-1' });
    const a = await placeOrder(shopA, [{ variantId: v, quantity: 1 }]);
    await placeOrder(shopB, [{ variantId: v, quantity: 1 }]);
    await act(a.body.id, 'accept');
    const retailerId = (await queryOne<any>("SELECT id FROM retailers WHERE name = 'Shop A'"))!.id;
    expect((await admin.get('/api/orders')).body.orders).toHaveLength(2);
    expect((await admin.get(`/api/orders?retailerId=${retailerId}`)).body.orders).toHaveLength(1);
    expect((await admin.get('/api/orders?status=SUBMITTED')).body.orders).toHaveLength(1);
    expect((await admin.get('/api/orders?deliveryStatus=PENDING')).body.orders).toHaveLength(2);
    expect((await admin.get(`/api/orders?from=${todayStr()}&to=${todayStr()}`)).body.orders).toHaveLength(2);
    expect((await admin.get(`/api/orders?from=${todayStr(2)}`)).body.orders).toHaveLength(0);
  });
});
