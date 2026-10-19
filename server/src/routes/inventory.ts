import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { query } from '../db.js';
import { asyncRoute, dateStr, parse } from '../lib.js';
import { recordReturnOrDamage, setPhysicalStock } from '../services/inventory.js';

export const inventoryRouter = Router();
inventoryRouter.use(requireAdmin);

inventoryRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const f = parse(
      z.object({
        q: z.string().trim().max(60).optional(),
        categoryId: z.coerce.number().int().optional(),
        low: z.enum(['0', '1']).optional(),
      }),
      req.query,
    );
    const params: unknown[] = [];
    const where: string[] = [];
    if (f.q) { params.push(f.q); where.push(`(p.name ILIKE '%' || $${params.length} || '%' OR v.sku ILIKE '%' || $${params.length} || '%' OR v.variant_name ILIKE '%' || $${params.length} || '%')`); }
    if (f.categoryId) { params.push(f.categoryId); where.push(`p.category_id = $${params.length}`); }
    if (f.low === '1') where.push('i.min_stock > 0 AND (i.physical_stock - i.reserved_stock) <= i.min_stock');
    const rows = await query(
      `SELECT v.id AS variant_id, p.name AS product_name, v.variant_name, v.sku, v.pack_size, v.pack_size_unit,
              v.stock_unit, v.units_per_crate, v.active, c.name AS category_name,
              i.physical_stock, i.reserved_stock, (i.physical_stock - i.reserved_stock) AS available_stock,
              i.min_stock, i.opening_stock,
              ((i.physical_stock - i.reserved_stock) <= i.min_stock AND i.min_stock > 0) AS is_low
         FROM variants v
         JOIN products p ON p.id = v.product_id
         JOIN categories c ON c.id = p.category_id
         JOIN inventory i ON i.variant_id = v.id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY c.sort_order, p.name, v.pack_size`,
      params,
    );
    res.json({ items: rows });
  }),
);

inventoryRouter.post(
  '/:variantId/adjust',
  asyncRoute(async (req, res) => {
    const b = parse(z.object({ newStock: z.number().int().min(0).max(10000000), reason: z.string() }), req.body);
    const after = await setPhysicalStock(req.user!.id, Number(req.params.variantId), b.newStock, b.reason, { ip: req.ip });
    res.json({ physicalStock: after.physical_stock, reservedStock: after.reserved_stock });
  }),
);

inventoryRouter.post(
  '/returns',
  asyncRoute(async (req, res) => {
    const b = parse(
      z.object({
        variantId: z.number().int().positive(),
        kind: z.enum(['RETURN', 'RETURN_DAMAGED', 'DAMAGED']),
        quantity: z.number().int().positive().max(1000000),
        retailerId: z.number().int().positive().nullish(),
        orderId: z.number().int().positive().nullish(),
        reason: z.string(),
      }),
      req.body,
    );
    const after = await recordReturnOrDamage(req.user!.id, b, req.ip);
    res.status(201).json({ physicalStock: after.physical_stock, reservedStock: after.reserved_stock });
  }),
);

inventoryRouter.get(
  '/transactions',
  asyncRoute(async (req, res) => {
    const f = parse(
      z.object({
        variantId: z.coerce.number().int().optional(),
        type: z.string().max(30).optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const params: unknown[] = [];
    const where: string[] = [];
    if (f.variantId) { params.push(f.variantId); where.push(`t.variant_id = $${params.length}`); }
    if (f.type) { params.push(f.type); where.push(`t.type = $${params.length}`); }
    if (f.from) { params.push(f.from); where.push(`t.created_at >= $${params.length}::date`); }
    if (f.to) { params.push(f.to); where.push(`t.created_at < ($${params.length}::date + 1)`); }
    const rows = await query(
      `SELECT t.id, t.created_at, t.type, t.physical_delta, t.reserved_delta, t.physical_after, t.reserved_after, t.quantity,
              t.reason, p.name || ' ' || v.variant_name AS product, v.sku, o.order_number, u.name AS user_name,
              r.name AS retailer_name
         FROM inventory_transactions t
         JOIN variants v ON v.id = t.variant_id
         JOIN products p ON p.id = v.product_id
         LEFT JOIN orders o ON o.id = t.order_id
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN retailers r ON r.id = t.retailer_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY t.id DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
      params,
    );
    res.json({ transactions: rows });
  }),
);
