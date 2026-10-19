import request from 'supertest';
import webpush from 'web-push';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/db.js';
import { app, login, makeAdmin, makeRetailer, makeVariant, placeOrder, resetDb } from './helpers.js';

vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn().mockResolvedValue({}), generateVAPIDKeys: vi.fn() },
}));
const send = webpush.sendNotification as unknown as ReturnType<typeof vi.fn>;

const sub = (name: string) => ({ endpoint: `https://push.example.com/${name}`, keys: { p256dh: 'p256dh-key-0123456789', auth: 'auth-key-1234' } });

let admin: Awaited<ReturnType<typeof login>>;
let shop: Awaited<ReturnType<typeof login>>;
let variant: number;

beforeEach(async () => {
  await resetDb();
  await query('TRUNCATE push_subscriptions RESTART IDENTITY');
  send.mockReset();
  send.mockResolvedValue({});
  await makeAdmin();
  await makeRetailer('Shop A', 'a@test.local');
  variant = await makeVariant({ sku: 'P-1' });
  admin = await login('admin@test.local');
  shop = await login('a@test.local');
});

describe('web push notifications', () => {
  it('exposes the public key to logged-in users only', async () => {
    expect((await request(app).get('/api/push/public-key')).status).toBe(401);
    const r = await admin.get('/api/push/public-key');
    expect(r.body.enabled).toBe(true);
    expect(r.body.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
    expect(JSON.stringify(r.body)).not.toContain(process.env.VAPID_PRIVATE_KEY!);
  });

  it('pushes to the distributor when a retailer places an order, and only to the distributor', async () => {
    expect((await admin.post('/api/push/subscribe').send(sub('admin-phone'))).status).toBe(201);
    expect((await shop.post('/api/push/subscribe').send(sub('shop-phone'))).status).toBe(201);
    const o = await placeOrder(shop, [{ variantId: variant, quantity: 3 }]);
    expect(o.status).toBe(201);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [target, payload] = send.mock.calls[0];
    expect(target.endpoint).toBe('https://push.example.com/admin-phone');
    const body = JSON.parse(payload);
    expect(body.title).toMatch(/New order ORD-/);
    expect(body.url).toBe(`/admin/orders/${o.body.id}`);
  });

  it('pushes status changes to the retailer, not the distributor', async () => {
    await admin.post('/api/push/subscribe').send(sub('admin-phone'));
    await shop.post('/api/push/subscribe').send(sub('shop-phone'));
    const o = await placeOrder(shop, [{ variantId: variant, quantity: 3 }]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 3000 });
    send.mockClear();
    await admin.post(`/api/orders/${o.body.id}/accept`).send({});
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(send.mock.calls[0][0].endpoint).toBe('https://push.example.com/shop-phone');
    expect(JSON.parse(send.mock.calls[0][1]).title).toMatch(/accepted/);
  });

  it('removes subscriptions the push service reports as gone', async () => {
    await admin.post('/api/push/subscribe').send(sub('dead-phone'));
    send.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
    await placeOrder(shop, [{ variantId: variant, quantity: 1 }]);
    await vi.waitFor(async () => expect((await query('SELECT id FROM push_subscriptions')).length).toBe(0), { timeout: 3000 });
  });

  it('moves a device to whoever subscribed last, and only the owner can unsubscribe it', async () => {
    await shop.post('/api/push/subscribe').send(sub('shared-phone'));
    await admin.post('/api/push/subscribe').send(sub('shared-phone'));
    const rows = await query<any>('SELECT u.role FROM push_subscriptions s JOIN users u ON u.id = s.user_id');
    expect(rows).toEqual([{ role: 'admin' }]);
    await shop.post('/api/push/unsubscribe').send({ endpoint: sub('shared-phone').endpoint });
    expect((await query('SELECT id FROM push_subscriptions')).length).toBe(1);
    await admin.post('/api/push/unsubscribe').send({ endpoint: sub('shared-phone').endpoint });
    expect((await query('SELECT id FROM push_subscriptions')).length).toBe(0);
  });

  it('rejects malformed subscriptions', async () => {
    expect((await admin.post('/api/push/subscribe').send({ endpoint: 'not-a-url', keys: {} })).status).toBe(400);
  });

  it('never lets a push failure break the order', async () => {
    await admin.post('/api/push/subscribe').send(sub('flaky'));
    send.mockRejectedValue(new Error('network down'));
    const o = await placeOrder(shop, [{ variantId: variant, quantity: 1 }]);
    expect(o.status).toBe(201);
  });
});
