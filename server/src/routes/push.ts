import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { asyncRoute, parse } from '../lib.js';
import { pushEnabled, pushToUser } from '../services/push.js';

export const pushRouter = Router();

pushRouter.get('/public-key', (_req, res) => {
  res.json({ enabled: pushEnabled(), publicKey: pushEnabled() ? config.vapidPublicKey : null });
});

const subSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(300), auth: z.string().min(5).max(100) }),
});

pushRouter.post(
  '/subscribe',
  asyncRoute(async (req, res) => {
    const b = parse(subSchema, req.body);
    // A device belongs to whoever logged in last, so shared phones never leak another user's alerts.
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [req.user!.id, b.endpoint, b.keys.p256dh, b.keys.auth, (req.get('user-agent') ?? '').slice(0, 300)],
    );
    res.status(201).json({ ok: true });
  }),
);

pushRouter.post(
  '/unsubscribe',
  asyncRoute(async (req, res) => {
    const { endpoint } = parse(z.object({ endpoint: z.string().url().max(2000) }), req.body);
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user!.id]);
    res.json({ ok: true });
  }),
);

pushRouter.post(
  '/test',
  asyncRoute(async (req, res) => {
    if (!pushEnabled()) return res.status(503).json({ error: { code: 'PUSH_DISABLED', message: 'Push notifications are not configured on the server' } });
    await pushToUser(req.user!.id, { title: 'Test notification', body: 'Push notifications are working on this device.', url: req.user!.role === 'admin' ? '/admin' : '/' });
    res.json({ ok: true });
  }),
);
