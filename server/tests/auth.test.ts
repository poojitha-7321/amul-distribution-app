import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { app, login, makeAdmin, makeRetailer, makeVariant, placeOrder, PASSWORD, resetDb } from './helpers.js';

describe('authentication and access control', () => {
  beforeEach(resetDb);

  it('logs in with correct credentials and rejects wrong ones', async () => {
    await makeRetailer('Shop A', 'a@test.local');
    const ok = await request(app).post('/api/auth/login').send({ email: 'a@test.local', password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('retailer');
    expect(ok.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
    const bad = await request(app).post('/api/auth/login').send({ email: 'a@test.local', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@test.local', password: 'whatever12' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(bad.body.error.message); // no account enumeration
  });

  it('stores only a bcrypt hash of the password', async () => {
    await makeRetailer('Shop A', 'a@test.local');
    const { rows } = await pool.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
  });

  it('requires authentication for protected routes', async () => {
    expect((await request(app).get('/api/catalog')).status).toBe(401);
    expect((await request(app).get('/api/orders')).status).toBe(401);
    expect((await request(app).get('/api/admin/inventory')).status).toBe(401);
  });

  it('keeps retailers out of every admin endpoint', async () => {
    await makeRetailer('Shop A', 'a@test.local');
    const a = await login('a@test.local');
    for (const path of ['/api/admin/retailers', '/api/admin/inventory', '/api/admin/products', '/api/admin/reports/current-stock', '/api/admin/audit', '/api/dashboard/admin']) {
      expect((await a.get(path)).status, path).toBe(403);
    }
    expect((await a.post('/api/admin/imports/products/validate').send({ rows: [{ sku: 'x' }] })).status).toBe(403);
    expect((await a.post('/api/admin/inventory/1/adjust').send({ newStock: 5, reason: 'cheat' })).status).toBe(403);
  });

  it("never lets one retailer see or cancel another retailer's order", async () => {
    await makeAdmin();
    await makeRetailer('Shop A', 'a@test.local');
    await makeRetailer('Shop B', 'b@test.local');
    const v = await makeVariant({ sku: 'T-1' });
    const a = await login('a@test.local');
    const b = await login('b@test.local');
    const created = await placeOrder(a, [{ variantId: v, quantity: 5 }]);
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await b.get(`/api/orders/${id}`)).status).toBe(404);
    expect((await b.post(`/api/orders/${id}/cancel`).send({})).status).toBe(404);
    expect((await b.get('/api/orders')).body.orders).toHaveLength(0);
    expect((await a.get('/api/orders')).body.orders).toHaveLength(1);
    // retailers cannot accept their own orders
    expect((await a.post(`/api/orders/${id}/accept`).send({})).status).toBe(403);
    expect((await a.post(`/api/orders/${id}/deliver`).send({})).status).toBe(403);
  });

  it('blocks deactivated retailers immediately, even with a valid session', async () => {
    await makeAdmin();
    const r = await makeRetailer('Shop A', 'a@test.local');
    const a = await login('a@test.local');
    const admin = await login('admin@test.local');
    expect((await a.get('/api/catalog')).status).toBe(200);
    expect((await admin.patch(`/api/admin/retailers/${r.retailerId}/active`).send({ active: false })).status).toBe(200);
    expect((await a.get('/api/catalog')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'a@test.local', password: PASSWORD })).status).toBe(401);
  });

  it('creates a retailer with a one-time password and resets passwords', async () => {
    await makeAdmin();
    const admin = await login('admin@test.local');
    const created = await admin.post('/api/admin/retailers').send({ name: 'New Shop', email: 'new@test.local', phone: '999' });
    expect(created.status).toBe(201);
    const temp = created.body.temporaryPassword as string;
    expect(temp.length).toBeGreaterThanOrEqual(10);
    const first = await request(app).post('/api/auth/login').send({ email: 'new@test.local', password: temp });
    expect(first.status).toBe(200);
    expect(first.body.user.mustChangePassword).toBe(true);

    const reset = await admin.post(`/api/admin/retailers/${created.body.retailer.id}/reset-password`).send({});
    expect(reset.status).toBe(200);
    expect(reset.body.temporaryPassword).not.toBe(temp);
    expect((await request(app).post('/api/auth/login').send({ email: 'new@test.local', password: temp })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'new@test.local', password: reset.body.temporaryPassword })).status).toBe(200);
    // duplicate email
    expect((await admin.post('/api/admin/retailers').send({ name: 'Other', email: 'NEW@test.local' })).status).toBe(409);
  });

  it('rejects cross-origin state-changing requests', async () => {
    await makeRetailer('Shop A', 'a@test.local');
    const res = await request(app).post('/api/auth/logout').set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
  });
});
