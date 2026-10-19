import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, queryOne, tx } from '../db.js';
import type { AuthUser } from '../auth.js';
import { audit, badRequest, conflict, dateStr, forbidden, getSettings, notFound, notifyAdmins, notifyRetailerUsers, todayStr } from '../lib.js';
import { applyMove, availableOf, checkLowStock, lockInventory } from './inventory.js';

export type OrderStatus =
  | 'SUBMITTED' | 'ACCEPTED' | 'PREPARING' | 'READY_FOR_DELIVERY'
  | 'PARTIALLY_DELIVERED' | 'DELIVERED' | 'REJECTED' | 'CANCELLED';

export const ORDER_STATUSES: OrderStatus[] = [
  'SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY_FOR_DELIVERY', 'PARTIALLY_DELIVERED', 'DELIVERED', 'REJECTED', 'CANCELLED',
];

export const createOrderSchema = z.object({
  deliveryDate: dateStr,
  notes: z.string().trim().max(500).optional(),
  submitToken: z.string().trim().min(8).max(100).optional(),
  items: z
    .array(
      z.object({
        variantId: z.number().int().positive(),
        unit: z.string().trim().min(1).max(20),
        quantity: z.number().int().positive().max(100000),
      }),
    )
    .min(1, 'Add at least one product')
    .max(200),
});

export async function recordStatus(db: PoolClient, orderId: number, from: string | null, to: string, userId: number | null, note?: string | null) {
  await db.query(
    'INSERT INTO order_status_history (order_id, from_status, to_status, user_id, note) VALUES ($1,$2,$3,$4,$5)',
    [orderId, from, to, userId, note ?? null],
  );
}

// ---------------------------------------------------------------------------
// Create order (retailer)
// ---------------------------------------------------------------------------
export async function createOrder(user: AuthUser, input: z.infer<typeof createOrderSchema>, ip?: string) {
  if (user.role !== 'retailer' || !user.retailerId) throw forbidden('Only retailers can place orders');
  const retailerId = user.retailerId;

  // Idempotent re-submit (double tap / retry): hand back the original order.
  if (input.submitToken) {
    const existing = await queryOne<{ id: number }>(
      'SELECT id FROM orders WHERE retailer_id = $1 AND submit_token = $2',
      [retailerId, input.submitToken],
    );
    if (existing) return { id: existing.id, duplicate: true };
  }

  const settings = await getSettings();
  const minDate = todayStr(1);
  const maxDate = todayStr(Number(settings.max_delivery_days_ahead || 14));
  if (input.deliveryDate < minDate) throw badRequest(`Delivery date must be ${minDate} or later (next-day delivery)`);
  if (input.deliveryDate > maxDate) throw badRequest(`Delivery date cannot be later than ${maxDate}`);

  // Merge repeated (variant, unit) lines.
  const merged = new Map<string, { variantId: number; unit: string; quantity: number }>();
  for (const it of input.items) {
    const key = `${it.variantId}:${it.unit}`;
    const cur = merged.get(key);
    if (cur) cur.quantity += it.quantity;
    else merged.set(key, { ...it });
  }
  const lines = [...merged.values()];

  try {
    return await tx(async (db) => {
      const ids = [...new Set(lines.map((l) => l.variantId))];
      const variants = await query<any>(
        `SELECT v.id, v.variant_name, v.sku, v.pack_size, v.pack_size_unit, v.stock_unit, v.units_per_crate,
                v.price, v.crate_price, v.active, p.name AS product_name, p.active AS product_active,
                c.name AS category_name, c.active AS category_active,
                i.physical_stock, i.reserved_stock
           FROM variants v
           JOIN products p ON p.id = v.product_id
           JOIN categories c ON c.id = p.category_id
           JOIN inventory i ON i.variant_id = v.id
          WHERE v.id = ANY($1::int[])`,
        [ids],
        db,
      );
      const byId = new Map(variants.map((v) => [v.id, v]));

      const shortages: any[] = [];
      const prepared = lines.map((l) => {
        const v = byId.get(l.variantId);
        if (!v || !v.active || !v.product_active || !v.category_active) {
          throw badRequest('One of the products is no longer available. Please refresh your catalogue.');
        }
        let factor = 1;
        let unitPrice: number | null = v.price;
        if (l.unit === 'crate') {
          if (!v.units_per_crate) throw badRequest(`${v.product_name} ${v.variant_name} is not sold by the crate`);
          factor = v.units_per_crate;
          unitPrice = v.crate_price ?? (v.price === null ? null : Math.round(v.price * factor * 100) / 100);
        } else if (l.unit !== v.stock_unit) {
          throw badRequest(`${v.product_name} ${v.variant_name} cannot be ordered in "${l.unit}"`);
        }
        return { l, v, factor, unitPrice, base: l.quantity * factor };
      });

      // Soft availability check (hard guarantee happens when the distributor accepts and reserves).
      if (settings.insufficient_stock_policy !== 'partial') {
        const wantByVariant = new Map<number, number>();
        for (const p of prepared) wantByVariant.set(p.v.id, (wantByVariant.get(p.v.id) ?? 0) + p.base);
        for (const [vid, want] of wantByVariant) {
          const v = byId.get(vid);
          const avail = availableOf(v);
          if (want > avail) {
            shortages.push({ variantId: vid, name: `${v.product_name} ${v.variant_name}`, requested: want, available: Math.max(avail, 0), stockUnit: v.stock_unit });
          }
        }
        if (shortages.length) {
          throw conflict(
            'Some items are not available in the requested quantity: ' +
              shortages.map((s) => `${s.name} (only ${s.available} ${s.stockUnit} available)`).join(', '),
            { shortages },
          );
        }
      }

      const pricedAll = prepared.every((p) => p.unitPrice !== null);
      const total = pricedAll ? prepared.reduce((s, p) => s + Math.round(p.unitPrice! * p.l.quantity * 100) / 100, 0) : null;

      const num = await queryOne<{ n: number }>("SELECT nextval('order_number_seq') AS n", [], db);
      const orderNumber = `ORD-${todayStr().replaceAll('-', '')}-${num!.n}`;
      const order = await queryOne<{ id: number }>(
        `INSERT INTO orders (order_number, retailer_id, placed_by, delivery_date, status, notes, total_amount, submit_token)
         VALUES ($1,$2,$3,$4,'SUBMITTED',$5,$6,$7) RETURNING id`,
        [orderNumber, retailerId, user.id, input.deliveryDate, input.notes ?? null, total, input.submitToken ?? null],
        db,
      );
      for (const p of prepared) {
        const packLabel = `${Number(p.v.pack_size)} ${p.v.pack_size_unit}`;
        const lineTotal = p.unitPrice === null ? null : Math.round(p.unitPrice * p.l.quantity * 100) / 100;
        await db.query(
          `INSERT INTO order_items
             (order_id, variant_id, product_name, variant_name, category_name, sku, pack_label, stock_unit,
              order_unit, units_per_order_unit, quantity, base_quantity, unit_price, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [order!.id, p.v.id, p.v.product_name, p.v.variant_name, p.v.category_name, p.v.sku, packLabel,
           p.v.stock_unit, p.l.unit, p.factor, p.l.quantity, p.base, p.unitPrice, lineTotal],
        );
      }
      await recordStatus(db, order!.id, null, 'SUBMITTED', user.id);
      await audit(db, user.id, 'order.create', 'order', order!.id, { orderNumber, lines: prepared.length }, ip);
      await notifyAdmins(db, `New order ${orderNumber}`, `${user.retailerName} placed an order for ${input.deliveryDate}`, `/admin/orders/${order!.id}`);
      return { id: order!.id, duplicate: false };
    });
  } catch (e: any) {
    // Two simultaneous submits with the same token: the loser hits the unique index.
    if (e?.code === '23505' && input.submitToken) {
      const existing = await queryOne<{ id: number }>('SELECT id FROM orders WHERE retailer_id = $1 AND submit_token = $2', [retailerId, input.submitToken]);
      if (existing) return { id: existing.id, duplicate: true };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------
export type OrderAction = 'accept' | 'reject' | 'prepare' | 'ready' | 'cancel';

const ADMIN_TRANSITIONS: Record<OrderAction, { from: OrderStatus[]; to: OrderStatus }> = {
  accept: { from: ['SUBMITTED'], to: 'ACCEPTED' },
  reject: { from: ['SUBMITTED'], to: 'REJECTED' },
  prepare: { from: ['ACCEPTED'], to: 'PREPARING' },
  ready: { from: ['PREPARING'], to: 'READY_FOR_DELIVERY' },
  cancel: { from: ['SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY_FOR_DELIVERY'], to: 'CANCELLED' },
};

async function loadOrderForUpdate(db: PoolClient, orderId: number) {
  const order = await queryOne<any>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId], db);
  if (!order) throw notFound('Order not found');
  return order;
}

async function releaseReservations(db: PoolClient, order: any, userId: number, reason: string) {
  const items = await query<any>(
    'SELECT id, variant_id, reserved_base_qty FROM order_items WHERE order_id = $1 AND reserved_base_qty > 0',
    [order.id],
    db,
  );
  if (!items.length) return;
  const inv = await lockInventory(db, items.map((i) => i.variant_id));
  for (const it of items) {
    await applyMove(db, inv, {
      variantId: it.variant_id, type: 'RELEASE', reservedDelta: -it.reserved_base_qty,
      orderId: order.id, retailerId: order.retailer_id, reason, userId,
    });
    await db.query('UPDATE order_items SET reserved_base_qty = 0 WHERE id = $1', [it.id]);
  }
}

async function reserveStock(db: PoolClient, order: any, userId: number, partialPolicy: boolean) {
  const items = await query<any>(
    'SELECT id, variant_id, base_quantity, product_name, variant_name, stock_unit FROM order_items WHERE order_id = $1 ORDER BY id',
    [order.id],
    db,
  );
  const inv = await lockInventory(db, items.map((i) => i.variant_id));
  const before = new Map([...inv].map(([k, v]) => [k, { ...v }]));

  const plan = items.map((it) => {
    const row = inv.get(it.variant_id)!;
    return { it, avail: availableOf(row) };
  });
  // Several lines can share a variant (e.g. packet + crate); track running availability.
  const running = new Map<number, number>();
  const shortages: any[] = [];
  const toReserve: { it: any; qty: number }[] = [];
  for (const { it, avail } of plan) {
    const left = running.has(it.variant_id) ? running.get(it.variant_id)! : avail;
    const qty = Math.max(0, Math.min(it.base_quantity, left));
    running.set(it.variant_id, left - qty);
    if (qty < it.base_quantity) {
      shortages.push({ name: `${it.product_name} ${it.variant_name}`, requested: it.base_quantity, available: qty, stockUnit: it.stock_unit });
    }
    toReserve.push({ it, qty });
  }
  if (shortages.length && !partialPolicy) {
    throw conflict(
      'Not enough stock to accept this order: ' + shortages.map((s) => `${s.name} (need ${s.requested}, available ${s.available})`).join(', '),
      { shortages },
    );
  }
  if (partialPolicy && toReserve.every((r) => r.qty === 0)) {
    throw conflict('No stock is available for any item in this order', { shortages });
  }
  for (const { it, qty } of toReserve) {
    if (qty === 0) continue;
    await applyMove(db, inv, {
      variantId: it.variant_id, type: 'RESERVE', reservedDelta: qty, orderId: order.id,
      retailerId: order.retailer_id, reason: `Reserved for ${order.order_number}`, userId,
    });
    await db.query('UPDATE order_items SET reserved_base_qty = $2 WHERE id = $1', [it.id, qty]);
  }
  for (const [vid, after] of inv) await checkLowStock(db, before.get(vid)!, after);
  return shortages;
}

export async function transitionOrder(user: AuthUser, orderId: number, action: OrderAction, note?: string, ip?: string) {
  const settings = await getSettings();
  return tx(async (db) => {
    const order = await loadOrderForUpdate(db, orderId);
    const from = order.status as OrderStatus;

    if (user.role === 'retailer') {
      if (action !== 'cancel' || order.retailer_id !== user.retailerId) {
        // Do not reveal other retailers' orders
        throw order.retailer_id !== user.retailerId ? notFound('Order not found') : forbidden();
      }
      const allowed: OrderStatus[] = settings.retailer_cancel_until === 'SUBMITTED' ? ['SUBMITTED'] : ['SUBMITTED', 'ACCEPTED'];
      if (!allowed.includes(from)) {
        throw conflict('This order can no longer be cancelled online. Please contact the distributor.');
      }
    } else if (user.role !== 'admin') {
      throw forbidden();
    }

    const rule = ADMIN_TRANSITIONS[action];
    if (!rule.from.includes(from)) {
      throw conflict(`Order is ${from.replaceAll('_', ' ').toLowerCase()}; cannot ${action} it now`);
    }

    let shortages: any[] = [];
    if (action === 'accept') {
      shortages = await reserveStock(db, order, user.id, settings.insufficient_stock_policy === 'partial');
    } else if (action === 'cancel') {
      await releaseReservations(db, order, user.id, `Order ${order.order_number} cancelled`);
    }

    await db.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [orderId, rule.to]);
    await recordStatus(db, orderId, from, rule.to, user.id, note);
    await audit(db, user.id, `order.${action}`, 'order', orderId, { from, to: rule.to, note }, ip);

    const label: Record<string, string> = {
      ACCEPTED: 'accepted', REJECTED: 'rejected', PREPARING: 'being prepared', READY_FOR_DELIVERY: 'ready for delivery', CANCELLED: 'cancelled',
    };
    if (user.role === 'admin') {
      await notifyRetailerUsers(db, order.retailer_id, `Order ${order.order_number} ${label[rule.to]}`, note ?? undefined, `/orders/${orderId}`);
    } else {
      await notifyAdmins(db, `Order ${order.order_number} cancelled by retailer`, user.retailerName ?? undefined, `/admin/orders/${orderId}`);
    }
    return { status: rule.to, shortages };
  });
}

// ---------------------------------------------------------------------------
// Delivery confirmation (full or partial)
// ---------------------------------------------------------------------------
export const deliverySchema = z.object({
  note: z.string().trim().max(500).optional(),
  items: z
    .array(z.object({ orderItemId: z.number().int().positive(), deliveredQuantity: z.number().int().min(0) }))
    .optional(),
});

export async function confirmDelivery(user: AuthUser, orderId: number, input: z.infer<typeof deliverySchema>, ip?: string) {
  if (user.role !== 'admin') throw forbidden();
  return tx(async (db) => {
    const order = await loadOrderForUpdate(db, orderId); // serialises concurrent confirmations
    if (order.status === 'DELIVERED' || order.status === 'PARTIALLY_DELIVERED') {
      throw conflict('Delivery has already been confirmed for this order');
    }
    if (order.status !== 'READY_FOR_DELIVERY') {
      throw conflict('Order must be marked ready for delivery before it can be delivered');
    }
    const items = await query<any>('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id FOR UPDATE', [orderId], db);

    const delivered = new Map<number, number>();
    if (input.items) {
      const ids = new Set(items.map((i) => i.id));
      const seen = new Set<number>();
      for (const d of input.items) {
        if (!ids.has(d.orderItemId)) throw badRequest('Delivery contains an item that is not part of this order');
        if (seen.has(d.orderItemId)) throw badRequest('Duplicate item in delivery');
        seen.add(d.orderItemId);
        delivered.set(d.orderItemId, d.deliveredQuantity);
      }
      if (seen.size !== ids.size) throw badRequest('Enter a delivered quantity for every item (use 0 if nothing was delivered)');
    } else {
      for (const it of items) delivered.set(it.id, it.quantity);
    }
    for (const it of items) {
      if (delivered.get(it.id)! > it.quantity) throw badRequest(`Cannot deliver more than ordered for ${it.product_name} ${it.variant_name}`);
    }
    if ([...delivered.values()].every((q) => q === 0)) {
      throw badRequest('Nothing was delivered. Cancel the order instead if it will not be delivered.');
    }

    const delivery = await queryOne<{ id: number }>(
      'INSERT INTO deliveries (order_id, confirmed_by, note) VALUES ($1,$2,$3) RETURNING id',
      [orderId, user.id, input.note ?? null],
      db,
    );
    const inv = await lockInventory(db, items.map((i) => i.variant_id));
    const before = new Map([...inv].map(([k, v]) => [k, { ...v }]));

    let allFull = true;
    let deliveredAmount: number | null = 0;
    for (const it of items) {
      const dq = delivered.get(it.id)!;
      const dBase = dq * it.units_per_order_unit;
      const undelivered = it.base_quantity - dBase;
      if (dq < it.quantity) allFull = false;
      const reservedUsed = Math.min(dBase, it.reserved_base_qty);
      const reservedLeft = it.reserved_base_qty - reservedUsed;

      if (dBase > 0) {
        await applyMove(db, inv, {
          variantId: it.variant_id, type: 'DELIVERY', physicalDelta: -dBase, reservedDelta: -reservedUsed,
          quantity: dBase, orderId, deliveryId: delivery!.id, retailerId: order.retailer_id,
          reason: `Delivered on ${order.order_number}`, userId: user.id,
        });
      } else if (reservedUsed > 0) {
        // unreachable (reservedUsed <= dBase), kept for clarity
      }
      if (reservedLeft > 0) {
        await applyMove(db, inv, {
          variantId: it.variant_id, type: 'RELEASE', reservedDelta: -reservedLeft, orderId,
          deliveryId: delivery!.id, retailerId: order.retailer_id,
          reason: `Undelivered balance released on ${order.order_number}`, userId: user.id,
        });
      }
      await db.query(
        'UPDATE order_items SET delivered_quantity = $2, delivered_base_qty = $3, reserved_base_qty = 0 WHERE id = $1',
        [it.id, dq, dBase],
      );
      await db.query(
        'INSERT INTO delivery_items (delivery_id, order_item_id, delivered_quantity, delivered_base_qty, undelivered_base_qty) VALUES ($1,$2,$3,$4,$5)',
        [delivery!.id, it.id, dq, dBase, undelivered],
      );
      if (it.unit_price === null) deliveredAmount = null;
      else if (deliveredAmount !== null) deliveredAmount += Math.round(it.unit_price * dq * 100) / 100;
    }

    const to: OrderStatus = allFull ? 'DELIVERED' : 'PARTIALLY_DELIVERED';
    await db.query('UPDATE orders SET status = $2, delivered_amount = $3, updated_at = now() WHERE id = $1', [orderId, to, deliveredAmount]);
    await recordStatus(db, orderId, order.status, to, user.id, input.note);
    await audit(db, user.id, 'order.deliver', 'order', orderId, {
      deliveryId: delivery!.id, status: to, items: [...delivered.entries()],
    }, ip);
    for (const [vid, after] of inv) await checkLowStock(db, before.get(vid)!, after);
    await notifyRetailerUsers(
      db, order.retailer_id,
      `Order ${order.order_number} ${allFull ? 'delivered' : 'partially delivered'}`,
      allFull ? undefined : 'Some items were short. Open the order to see delivered quantities.',
      `/orders/${orderId}`,
    );
    return { status: to, deliveryId: delivery!.id };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function getOrderDetail(user: AuthUser, orderId: number) {
  const order = await queryOne<any>(
    `SELECT o.*, r.name AS retailer_name, r.phone AS retailer_phone, r.address AS retailer_address, u.name AS placed_by_name
       FROM orders o JOIN retailers r ON r.id = o.retailer_id JOIN users u ON u.id = o.placed_by
      WHERE o.id = $1`,
    [orderId],
  );
  // Retailers get a 404 (not 403) for other retailers' orders so existence is not revealed.
  if (!order || (user.role === 'retailer' && order.retailer_id !== user.retailerId)) throw notFound('Order not found');
  const items = await query<any>('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]);
  const history = await query<any>(
    `SELECT h.*, u.name AS user_name FROM order_status_history h LEFT JOIN users u ON u.id = h.user_id
      WHERE h.order_id = $1 ORDER BY h.id`,
    [orderId],
  );
  const delivery = await queryOne<any>(
    `SELECT d.*, u.name AS confirmed_by_name FROM deliveries d JOIN users u ON u.id = d.confirmed_by WHERE d.order_id = $1`,
    [orderId],
  );
  let stock: any[] = [];
  if (user.role === 'admin') {
    stock = await query<any>(
      `SELECT variant_id, physical_stock, reserved_stock, (physical_stock - reserved_stock) AS available_stock
         FROM inventory WHERE variant_id IN (SELECT variant_id FROM order_items WHERE order_id = $1)`,
      [orderId],
    );
  }
  return { order, items, history, delivery, stock };
}

/** Rebuilds a cart from a previous order using today's catalogue (inactive/unknown items are skipped and reported). */
export async function reorderPreview(user: AuthUser, orderId: number) {
  const { items } = await getOrderDetail(user, orderId);
  const lines: any[] = [];
  const skipped: string[] = [];
  for (const it of items) {
    const v = await queryOne<any>(
      `SELECT v.id, v.stock_unit, v.units_per_crate, v.active, p.active AS pa, c.active AS ca
         FROM variants v JOIN products p ON p.id = v.product_id JOIN categories c ON c.id = p.category_id WHERE v.id = $1`,
      [it.variant_id],
    );
    const unitOk = v && (it.order_unit === 'crate' ? !!v.units_per_crate : it.order_unit === v.stock_unit);
    if (!v || !v.active || !v.pa || !v.ca || !unitOk) {
      skipped.push(`${it.product_name} ${it.variant_name}`);
      continue;
    }
    lines.push({ variantId: it.variant_id, unit: it.order_unit, quantity: it.quantity });
  }
  return { lines, skipped };
}
