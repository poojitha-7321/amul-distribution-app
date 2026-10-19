import webpush from 'web-push';
import { config } from '../config.js';
import { pool, query } from '../db.js';

export const pushEnabled = () => !!(config.vapidPublicKey && config.vapidPrivateKey);

let configured = false;
function ensureConfigured() {
  if (configured || !pushEnabled()) return pushEnabled();
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body?: string | null;
  url?: string | null;
}

interface Sub {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function deliver(subs: Sub[], payload: PushPayload) {
  if (!subs.length || !ensureConfigured()) return;
  const body = JSON.stringify({ title: payload.title, body: payload.body ?? '', url: payload.url ?? '/' });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 60 * 60 * 24, urgency: 'high' });
      } catch (err: any) {
        // 404/410 = the device unsubscribed or the subscription expired: forget it.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => undefined);
        } else {
          console.warn('push delivery failed:', err?.statusCode ?? err?.message);
        }
      }
    }),
  );
}

export async function pushToAdmins(payload: PushPayload) {
  const subs = await query<Sub>(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
       JOIN users u ON u.id = s.user_id WHERE u.role = 'admin' AND u.active`,
  );
  await deliver(subs, payload);
}

export async function pushToRetailer(retailerId: number, payload: PushPayload) {
  const subs = await query<Sub>(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
       JOIN users u ON u.id = s.user_id WHERE u.retailer_id = $1 AND u.active`,
    [retailerId],
  );
  await deliver(subs, payload);
}

export async function pushToUser(userId: number, payload: PushPayload) {
  const subs = await query<Sub>('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
  await deliver(subs, payload);
}

/** Runs after the surrounding database transaction has had time to commit; never throws. */
export function later(fn: () => Promise<unknown>) {
  if (!pushEnabled()) return;
  setTimeout(() => {
    fn().catch((e) => console.warn('push failed:', e?.message ?? e));
  }, 400);
}
