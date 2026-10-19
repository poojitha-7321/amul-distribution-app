import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireRetailer } from '../auth.js';
import { query } from '../db.js';
import { config } from '../config.js';
import { asyncRoute, dateStr, notFound, parse } from '../lib.js';
import {
  ORDER_STATUSES, confirmDelivery, createOrderSchema, createOrder, deliverySchema,
  getOrderDetail, reorderPreview, transitionOrder, type OrderAction,
} from '../services/orders.js';

export const ordersRouter = Router();

const listSchema = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  deliveryFrom: dateStr.optional(),
  deliveryTo: dateStr.optional(),
  retailerId: z.coerce.number().int().positive().optional(),
  status: z.enum(ORDER_STATUSES as [string, ...string[]]).optional(),
  deliveryStatus: z.enum(['PENDING', 'DELIVERED', 'PARTIAL', 'NONE']).optional(),
  q: z.string().trim().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

ordersRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const f = parse(listSchema, req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
    const local = () => { params.push(config.timezone); return `(o.created_at AT TIME ZONE $${params.length})::date`; };

    if (req.user!.role === 'retailer') add('o.retailer_id = ?', req.user!.retailerId);
    else if (f.retailerId) add('o.retailer_id = ?', f.retailerId);
    // Order date is evaluated in the business timezone via a stored-date cast.
    if (f.from) { const d = local(); add(`${d} >= ?::date`, f.from); }
    if (f.to) { const d = local(); add(`${d} <= ?::date`, f.to); }
    if (f.deliveryFrom) add('o.delivery_date >= ?::date', f.deliveryFrom);
    if (f.deliveryTo) add('o.delivery_date <= ?::date', f.deliveryTo);
    if (f.status) add('o.status = ?', f.status);
    if (f.q) add("(o.order_number ILIKE '%' || ? || '%' OR r.name ILIKE '%' || ? || '%')", f.q);
    if (f.deliveryStatus === 'PENDING') where.push("o.status IN ('SUBMITTED','ACCEPTED','PREPARING','READY_FOR_DELIVERY')");
    if (f.deliveryStatus === 'DELIVERED') where.push("o.status = 'DELIVERED'");
    if (f.deliveryStatus === 'PARTIAL') where.push("o.status = 'PARTIALLY_DELIVERED'");
    if (f.deliveryStatus === 'NONE') where.push("o.status IN ('REJECTED','CANCELLED')");

    const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await query(
      `SELECT o.id, o.order_number, o.retailer_id, r.name AS retailer_name, o.created_at, o.delivery_date, o.status,
              o.total_amount, o.delivered_amount,
              (SELECT count(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
              CASE WHEN o.status = 'DELIVERED' THEN 'DELIVERED'
                   WHEN o.status = 'PARTIALLY_DELIVERED' THEN 'PARTIAL'
                   WHEN o.status IN ('REJECTED','CANCELLED') THEN 'NONE'
                   ELSE 'PENDING' END AS delivery_status,
              count(*) OVER () AS total_count
         FROM orders o JOIN retailers r ON r.id = o.retailer_id
         ${sqlWhere}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ${f.limit} OFFSET ${f.offset}`,
      params,
    );
    res.json({ orders: rows, total: rows[0] ? (rows[0] as any).total_count : 0 });
  }),
);

ordersRouter.post(
  '/',
  requireRetailer,
  asyncRoute(async (req, res) => {
    const body = parse(createOrderSchema, req.body);
    const result = await createOrder(req.user!, body, req.ip);
    res.status(result.duplicate ? 200 : 201).json(result);
  }),
);

ordersRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.json(await getOrderDetail(req.user!, Number(req.params.id)));
  }),
);

ordersRouter.get(
  '/:id/reorder',
  requireRetailer,
  asyncRoute(async (req, res) => {
    res.json(await reorderPreview(req.user!, Number(req.params.id)));
  }),
);

ordersRouter.post(
  '/:id/deliver',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = parse(deliverySchema, req.body ?? {});
    res.json(await confirmDelivery(req.user!, Number(req.params.id), body, req.ip));
  }),
);

const actionSchema = z.object({ note: z.string().trim().max(500).optional() });

// Retailers may only cancel (enforced again in the service); admins may run any transition.
ordersRouter.post(
  '/:id/:action',
  asyncRoute(async (req, res) => {
    const action = String(req.params.action);
    if (!['accept', 'reject', 'prepare', 'ready', 'cancel'].includes(action)) throw notFound('Unknown action');
    const { note } = parse(actionSchema, req.body ?? {});
    const out = await transitionOrder(req.user!, Number(req.params.id), action as OrderAction, note, req.ip);
    res.json(out);
  }),
);
