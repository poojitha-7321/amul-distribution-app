import type { PoolClient } from 'pg';
import { query, queryOne, tx } from '../db.js';
import { audit, badRequest, conflict, notFound, notifyAdmins } from '../lib.js';

export type TxType =
  | 'OPENING'
  | 'RESERVE'
  | 'RELEASE'
  | 'DELIVERY'
  | 'ADJUSTMENT'
  | 'RETURN'
  | 'RETURN_DAMAGED'
  | 'DAMAGED';

export interface InvRow {
  variant_id: number;
  physical_stock: number;
  reserved_stock: number;
  min_stock: number;
}

/** Row-locks inventory rows in a stable order (prevents deadlocks, serialises writers). */
export async function lockInventory(db: PoolClient, variantIds: number[]): Promise<Map<number, InvRow>> {
  const ids = [...new Set(variantIds)].sort((a, b) => a - b);
  const rows = await query<InvRow>(
    `SELECT variant_id, physical_stock, reserved_stock, min_stock
       FROM inventory WHERE variant_id = ANY($1::int[]) ORDER BY variant_id FOR UPDATE`,
    [ids],
    db,
  );
  const map = new Map(rows.map((r) => [r.variant_id, r]));
  for (const id of ids) if (!map.has(id)) throw notFound(`Inventory record missing for variant ${id}`);
  return map;
}

export interface StockMove {
  variantId: number;
  type: TxType;
  physicalDelta?: number;
  reservedDelta?: number;
  quantity?: number;
  orderId?: number | null;
  deliveryId?: number | null;
  retailerId?: number | null;
  reason?: string | null;
  userId?: number | null;
}

/** Applies a stock movement to a row that the caller has already locked, and records it.
 *  The inventory CHECK constraints are the last line of defence against negative/oversold stock. */
export async function applyMove(db: PoolClient, inv: Map<number, InvRow>, m: StockMove): Promise<InvRow> {
  const row = inv.get(m.variantId);
  if (!row) throw new Error('applyMove called for a variant that was not locked');
  const pd = m.physicalDelta ?? 0;
  const rd = m.reservedDelta ?? 0;
  const physical = row.physical_stock + pd;
  const reserved = row.reserved_stock + rd;
  if (physical < 0 || reserved < 0 || reserved > physical) {
    throw conflict('Stock would become inconsistent (insufficient stock)', {
      variantId: m.variantId,
      physical: row.physical_stock,
      reserved: row.reserved_stock,
    });
  }
  await db.query(
    'UPDATE inventory SET physical_stock = $2, reserved_stock = $3, updated_at = now() WHERE variant_id = $1',
    [m.variantId, physical, reserved],
  );
  await db.query(
    `INSERT INTO inventory_transactions
       (variant_id, type, physical_delta, reserved_delta, physical_after, reserved_after, quantity,
        order_id, delivery_id, retailer_id, reason, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      m.variantId, m.type, pd, rd, physical, reserved,
      m.quantity ?? Math.max(Math.abs(pd), Math.abs(rd)),
      m.orderId ?? null, m.deliveryId ?? null, m.retailerId ?? null, m.reason ?? null, m.userId ?? null,
    ],
  );
  const updated = { ...row, physical_stock: physical, reserved_stock: reserved };
  inv.set(m.variantId, updated);
  return updated;
}

/** Emits a low-stock alert when available stock crosses the minimum threshold. */
export async function checkLowStock(db: PoolClient, before: InvRow, after: InvRow) {
  const availBefore = before.physical_stock - before.reserved_stock;
  const availAfter = after.physical_stock - after.reserved_stock;
  if (after.min_stock > 0 && availAfter <= after.min_stock && availBefore > after.min_stock) {
    const v = await queryOne<{ label: string }>(
      `SELECT p.name || ' ' || v.variant_name AS label FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1`,
      [after.variant_id],
      db,
    );
    await notifyAdmins(
      db,
      'Low stock',
      `${v?.label ?? 'Product'}: only ${availAfter} available (minimum ${after.min_stock})`,
      '/admin/inventory?low=1',
    );
  }
}

export const reasonSchema = (r: unknown) => {
  const s = typeof r === 'string' ? r.trim() : '';
  if (s.length < 3) throw badRequest('A reason (at least 3 characters) is required');
  return s;
};

/** Same as setPhysicalStock but joins the caller's transaction (used by bulk stock import). */
export async function setPhysicalStockInTx(
  db: PoolClient,
  userId: number,
  variantId: number,
  newPhysical: number,
  why: string,
  type: 'ADJUSTMENT' | 'OPENING' = 'ADJUSTMENT',
  ip?: string,
) {
  if (!Number.isInteger(newPhysical) || newPhysical < 0) throw badRequest('Stock must be a whole number, 0 or more');
  const inv = await lockInventory(db, [variantId]);
  const before = inv.get(variantId)!;
  const delta = newPhysical - before.physical_stock;
  if (newPhysical < before.reserved_stock) {
    throw conflict(`Cannot set stock below the ${before.reserved_stock} units already reserved for accepted orders`);
  }
  if (delta === 0 && type !== 'OPENING') return before;
  const after = await applyMove(db, inv, { variantId, type, physicalDelta: delta, reason: why, userId });
  if (type === 'OPENING') {
    await db.query('UPDATE inventory SET opening_stock = $2 WHERE variant_id = $1', [variantId, newPhysical]);
  }
  await audit(db, userId, type === 'OPENING' ? 'stock.opening' : 'stock.adjust', 'variant', variantId, {
    from: before.physical_stock, to: newPhysical, reason: why,
  }, ip);
  await checkLowStock(db, before, after);
  return after;
}

/** Manual correction: sets physical stock to an absolute count (e.g. after a physical stock-take). */
export async function setPhysicalStock(
  userId: number,
  variantId: number,
  newPhysical: number,
  reason: unknown,
  opts: { type?: 'ADJUSTMENT' | 'OPENING'; ip?: string } = {},
) {
  const why = reasonSchema(reason);
  return tx((db) => setPhysicalStockInTx(db, userId, variantId, newPhysical, why, opts.type ?? 'ADJUSTMENT', opts.ip));
}

export async function recordReturnOrDamage(
  userId: number,
  input: { variantId: number; kind: 'RETURN' | 'RETURN_DAMAGED' | 'DAMAGED'; quantity: number; retailerId?: number | null; orderId?: number | null; reason: unknown },
  ip?: string,
) {
  const why = reasonSchema(input.reason);
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw badRequest('Quantity must be a positive whole number');
  return tx(async (db) => {
    const inv = await lockInventory(db, [input.variantId]);
    const before = inv.get(input.variantId)!;
    const physicalDelta = input.kind === 'RETURN' ? input.quantity : input.kind === 'DAMAGED' ? -input.quantity : 0;
    const after = await applyMove(db, inv, {
      variantId: input.variantId, type: input.kind, physicalDelta, quantity: input.quantity,
      retailerId: input.retailerId ?? null, orderId: input.orderId ?? null, reason: why, userId,
    });
    await audit(db, userId, `stock.${input.kind.toLowerCase()}`, 'variant', input.variantId, { ...input, reason: why }, ip);
    await checkLowStock(db, before, after);
    return after;
  });
}

export function availableOf(r: Pick<InvRow, 'physical_stock' | 'reserved_stock'>) {
  return r.physical_stock - r.reserved_stock;
}

