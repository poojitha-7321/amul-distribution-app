import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireRetailer } from '../auth.js';
import { config } from '../config.js';
import { pool, query, queryOne } from '../db.js';
import { asyncRoute, audit, getSettings, parse, todayStr } from '../lib.js';

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------
export const dashboardRouter = Router();

dashboardRouter.get(
  '/admin',
  requireAdmin,
  asyncRoute(async (_req, res) => {
    const today = todayStr();
    const [cards] = await query<any>(
      `SELECT
         (SELECT count(*) FROM retailers WHERE active) AS active_retailers,
         (SELECT count(*) FROM orders WHERE (created_at AT TIME ZONE $2)::date = $1::date) AS orders_today,
         (SELECT count(*) FROM orders WHERE status = 'SUBMITTED') AS awaiting_processing,
         (SELECT count(*) FROM orders WHERE status IN ('ACCEPTED','PREPARING','READY_FOR_DELIVERY')) AS awaiting_delivery,
         (SELECT count(*) FROM deliveries WHERE (delivered_at AT TIME ZONE $2)::date = $1::date) AS delivered_today,
         (SELECT count(*) FROM inventory i JOIN variants v ON v.id = i.variant_id
           WHERE v.active AND i.min_stock > 0 AND (i.physical_stock - i.reserved_stock) <= i.min_stock) AS low_stock`,
      [today, config.timezone],
    );
    const upcoming = await query(
      `SELECT delivery_date, count(*) AS orders FROM orders
        WHERE status IN ('SUBMITTED','ACCEPTED','PREPARING','READY_FOR_DELIVERY') AND delivery_date >= $1::date
        GROUP BY delivery_date ORDER BY delivery_date LIMIT 7`,
      [today],
    );
    res.json({ today, cards, upcoming });
  }),
);

dashboardRouter.get(
  '/retailer',
  requireRetailer,
  asyncRoute(async (req, res) => {
    const rid = req.user!.retailerId;
    const [counts] = await query<any>(
      `SELECT count(*) FILTER (WHERE status IN ('SUBMITTED','ACCEPTED','PREPARING','READY_FOR_DELIVERY')) AS open_orders,
              count(*) FILTER (WHERE status IN ('DELIVERED','PARTIALLY_DELIVERED')) AS delivered_orders
         FROM orders WHERE retailer_id = $1`,
      [rid],
    );
    const recent = await query(
      `SELECT id, order_number, status, delivery_date, total_amount, created_at,
              (SELECT count(*) FROM order_items i WHERE i.order_id = orders.id) AS item_count
         FROM orders WHERE retailer_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [rid],
    );
    // Frequently ordered: variants this retailer ordered most in the last 90 days that are still orderable.
    const frequent = await query(
      `SELECT v.id AS variant_id, p.name AS product_name, v.variant_name, v.pack_size, v.pack_size_unit, v.stock_unit,
              count(DISTINCT o.id) AS times_ordered
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN variants v ON v.id = oi.variant_id AND v.active
         JOIN products p ON p.id = v.product_id AND p.active
        WHERE o.retailer_id = $1 AND o.status NOT IN ('REJECTED','CANCELLED') AND o.created_at > now() - interval '90 days'
        GROUP BY v.id, p.name, v.variant_name, v.pack_size, v.pack_size_unit, v.stock_unit
        ORDER BY times_ordered DESC, p.name LIMIT 6`,
      [rid],
    );
    res.json({ counts, recent, frequent });
  }),
);

// ---------------------------------------------------------------------------
// Notifications (in-app)
// ---------------------------------------------------------------------------
export const notificationsRouter = Router();

const visible = `(n.user_id = $1 OR ($2 AND n.for_admins))`;

notificationsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const uid = req.user!.id;
    const isAdmin = req.user!.role === 'admin';
    const rows = await query<any>(
      `SELECT n.id, n.title, n.body, n.link, n.created_at, ($1 = ANY(n.read_by)) AS read
         FROM notifications n WHERE ${visible} ORDER BY n.id DESC LIMIT 30`,
      [uid, isAdmin],
    );
    const unread = rows.filter((r) => !r.read).length;
    res.json({ notifications: rows, unread });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncRoute(async (req, res) => {
    await pool.query(
      `UPDATE notifications n SET read_by = array_append(read_by, $1)
        WHERE ${visible} AND NOT ($1 = ANY(n.read_by))`,
      [req.user!.id, req.user!.role === 'admin'],
    );
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/:id/read',
  asyncRoute(async (req, res) => {
    await pool.query(
      `UPDATE notifications n SET read_by = array_append(read_by, $1)
        WHERE n.id = $3 AND ${visible} AND NOT ($1 = ANY(n.read_by))`,
      [req.user!.id, req.user!.role === 'admin', Number(req.params.id)],
    );
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export const settingsRouter = Router();

settingsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const s = await getSettings();
    const base = { minDeliveryDate: todayStr(1), maxDeliveryDate: todayStr(Number(s.max_delivery_days_ahead || 14)), insufficientStockPolicy: s.insufficient_stock_policy };
    if (req.user!.role !== 'admin') return res.json(base);
    res.json({ ...base, retailerCancelUntil: s.retailer_cancel_until, maxDeliveryDaysAhead: Number(s.max_delivery_days_ahead) });
  }),
);

settingsRouter.put(
  '/',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const b = parse(
      z.object({
        insufficientStockPolicy: z.enum(['block', 'partial']),
        retailerCancelUntil: z.enum(['SUBMITTED', 'ACCEPTED']),
        maxDeliveryDaysAhead: z.number().int().min(1).max(60),
      }),
      req.body,
    );
    const entries: [string, string][] = [
      ['insufficient_stock_policy', b.insufficientStockPolicy],
      ['retailer_cancel_until', b.retailerCancelUntil],
      ['max_delivery_days_ahead', String(b.maxDeliveryDaysAhead)],
    ];
    for (const [k, v] of entries) {
      await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
    }
    await audit(pool, req.user!.id, 'settings.update', 'settings', null, b, req.ip);
    res.json({ ok: true });
  }),
);

export async function auditLogRows(limit = 200) {
  return query(
    `SELECT a.id, a.created_at, a.action, a.entity, a.entity_id, a.details, u.name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT $1`,
    [limit],
  );
}
export const auditRouter = Router();
auditRouter.get('/', requireAdmin, asyncRoute(async (_req, res) => res.json({ logs: await auditLogRows() })));

void queryOne;
