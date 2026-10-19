import { config } from '../config.js';
import { query } from '../db.js';
import { badRequest } from '../lib.js';

export interface ReportFilters {
  from?: string;
  to?: string;
  retailerId?: number;
}

interface ReportDef {
  title: string;
  columns: { key: string; label: string }[];
  run: (f: ReportFilters) => Promise<Record<string, unknown>[]>;
}

class Params {
  list: unknown[] = [];
  add(v: unknown) { this.list.push(v); return `$${this.list.length}`; }
}

/** Date-range clause on a timestamptz column, evaluated in the business timezone. */
function range(p: Params, col: string, f: ReportFilters): string[] {
  const out: string[] = [];
  if (!f.from && !f.to) return out; // avoid binding an unused parameter
  const tz = p.add(config.timezone);
  if (f.from) out.push(`(${col} AT TIME ZONE ${tz})::date >= ${p.add(f.from)}::date`);
  if (f.to) out.push(`(${col} AT TIME ZONE ${tz})::date <= ${p.add(f.to)}::date`);
  return out;
}

const W = (parts: string[]) => (parts.length ? 'WHERE ' + parts.join(' AND ') : '');

export const REPORTS: Record<string, ReportDef> = {
  'daily-orders': {
    title: 'Daily orders',
    columns: [
      { key: 'order_date', label: 'Date' }, { key: 'orders', label: 'Orders' },
      { key: 'cancelled', label: 'Cancelled/Rejected' }, { key: 'items', label: 'Line items' }, { key: 'amount', label: 'Order value' },
    ],
    run: async (f) => {
      const p = new Params();
      const tz = p.add(config.timezone);
      const where = [...range(p, 'o.created_at', f)];
      if (f.retailerId) where.push(`o.retailer_id = ${p.add(f.retailerId)}`);
      return query(
        `SELECT to_char((o.created_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS order_date,
                count(*) AS orders,
                count(*) FILTER (WHERE o.status IN ('CANCELLED','REJECTED')) AS cancelled,
                coalesce(sum((SELECT count(*) FROM order_items i WHERE i.order_id = o.id)), 0) AS items,
                sum(o.total_amount) FILTER (WHERE o.status NOT IN ('CANCELLED','REJECTED')) AS amount
           FROM orders o ${W(where)} GROUP BY 1 ORDER BY 1 DESC`,
        p.list,
      );
    },
  },
  'retailer-orders': {
    title: 'Retailer-wise orders',
    columns: [
      { key: 'retailer', label: 'Retailer' }, { key: 'orders', label: 'Orders' }, { key: 'delivered', label: 'Delivered' },
      { key: 'partial', label: 'Partially delivered' }, { key: 'cancelled', label: 'Cancelled/Rejected' },
      { key: 'ordered_amount', label: 'Ordered value' }, { key: 'delivered_amount', label: 'Delivered value' },
    ],
    run: async (f) => {
      const p = new Params();
      const where = [...range(p, 'o.created_at', f)];
      if (f.retailerId) where.push(`o.retailer_id = ${p.add(f.retailerId)}`);
      return query(
        `SELECT r.name AS retailer, count(*) AS orders,
                count(*) FILTER (WHERE o.status = 'DELIVERED') AS delivered,
                count(*) FILTER (WHERE o.status = 'PARTIALLY_DELIVERED') AS partial,
                count(*) FILTER (WHERE o.status IN ('CANCELLED','REJECTED')) AS cancelled,
                sum(o.total_amount) FILTER (WHERE o.status NOT IN ('CANCELLED','REJECTED')) AS ordered_amount,
                sum(o.delivered_amount) AS delivered_amount
           FROM orders o JOIN retailers r ON r.id = o.retailer_id ${W(where)}
          GROUP BY r.name ORDER BY orders DESC, r.name`,
        p.list,
      );
    },
  },
  'product-ordered': {
    title: 'Product-wise quantities ordered',
    columns: [
      { key: 'product', label: 'Product' }, { key: 'sku', label: 'SKU' }, { key: 'orders', label: 'Orders' },
      { key: 'ordered_units', label: 'Ordered (stock units)' }, { key: 'stock_unit', label: 'Unit' },
    ],
    run: async (f) => {
      const p = new Params();
      const where = [...range(p, 'o.created_at', f), "o.status NOT IN ('CANCELLED','REJECTED')"];
      if (f.retailerId) where.push(`o.retailer_id = ${p.add(f.retailerId)}`);
      return query(
        `SELECT i.product_name || ' ' || i.variant_name AS product, i.sku, count(DISTINCT o.id) AS orders,
                sum(i.base_quantity) AS ordered_units, i.stock_unit
           FROM order_items i JOIN orders o ON o.id = i.order_id ${W(where)}
          GROUP BY i.product_name, i.variant_name, i.sku, i.stock_unit ORDER BY ordered_units DESC`,
        p.list,
      );
    },
  },
  'product-delivered': {
    title: 'Product-wise quantities delivered',
    columns: [
      { key: 'product', label: 'Product' }, { key: 'sku', label: 'SKU' }, { key: 'ordered_units', label: 'Ordered' },
      { key: 'delivered_units', label: 'Delivered' }, { key: 'short_units', label: 'Short' }, { key: 'stock_unit', label: 'Unit' },
    ],
    run: async (f) => {
      const p = new Params();
      const where = [...range(p, 'o.updated_at', f), "o.status IN ('DELIVERED','PARTIALLY_DELIVERED')"];
      if (f.retailerId) where.push(`o.retailer_id = ${p.add(f.retailerId)}`);
      return query(
        `SELECT i.product_name || ' ' || i.variant_name AS product, i.sku, sum(i.base_quantity) AS ordered_units,
                sum(i.delivered_base_qty) AS delivered_units, sum(i.base_quantity - i.delivered_base_qty) AS short_units, i.stock_unit
           FROM order_items i JOIN orders o ON o.id = i.order_id ${W(where)}
          GROUP BY i.product_name, i.variant_name, i.sku, i.stock_unit ORDER BY delivered_units DESC`,
        p.list,
      );
    },
  },
  'pending-deliveries': {
    title: 'Pending deliveries',
    columns: [
      { key: 'order_number', label: 'Order' }, { key: 'retailer', label: 'Retailer' }, { key: 'delivery_date', label: 'Delivery date' },
      { key: 'status', label: 'Status' }, { key: 'items', label: 'Items' }, { key: 'amount', label: 'Value' },
    ],
    run: async (f) => {
      const p = new Params();
      const where = ["o.status IN ('SUBMITTED','ACCEPTED','PREPARING','READY_FOR_DELIVERY')"];
      if (f.from) where.push(`o.delivery_date >= ${p.add(f.from)}::date`);
      if (f.to) where.push(`o.delivery_date <= ${p.add(f.to)}::date`);
      if (f.retailerId) where.push(`o.retailer_id = ${p.add(f.retailerId)}`);
      return query(
        `SELECT o.order_number, r.name AS retailer, o.delivery_date, o.status,
                (SELECT count(*) FROM order_items i WHERE i.order_id = o.id) AS items, o.total_amount AS amount
           FROM orders o JOIN retailers r ON r.id = o.retailer_id ${W(where)} ORDER BY o.delivery_date, o.id`,
        p.list,
      );
    },
  },
  'cancelled-orders': {
    title: 'Cancelled and rejected orders',
    columns: [
      { key: 'order_number', label: 'Order' }, { key: 'retailer', label: 'Retailer' }, { key: 'status', label: 'Status' },
      { key: 'cancelled_at', label: 'When' }, { key: 'by', label: 'By' }, { key: 'note', label: 'Note' }, { key: 'amount', label: 'Value' },
    ],
    run: async (f) => {
      const p = new Params();
      const where = ["o.status IN ('CANCELLED','REJECTED')", ...range(p, 'o.updated_at', f)];
      if (f.retailerId) where.push(`o.retailer_id = ${p.add(f.retailerId)}`);
      return query(
        `SELECT o.order_number, r.name AS retailer, o.status, to_char(o.updated_at, 'YYYY-MM-DD HH24:MI') AS cancelled_at,
                u.name AS by, h.note, o.total_amount AS amount
           FROM orders o JOIN retailers r ON r.id = o.retailer_id
           LEFT JOIN LATERAL (SELECT * FROM order_status_history WHERE order_id = o.id AND to_status = o.status ORDER BY id DESC LIMIT 1) h ON TRUE
           LEFT JOIN users u ON u.id = h.user_id
           ${W(where)} ORDER BY o.updated_at DESC`,
        p.list,
      );
    },
  },
  'current-stock': {
    title: 'Current stock',
    columns: [
      { key: 'category', label: 'Category' }, { key: 'product', label: 'Product' }, { key: 'sku', label: 'SKU' },
      { key: 'physical', label: 'Physical' }, { key: 'reserved', label: 'Reserved' }, { key: 'available', label: 'Available' },
      { key: 'min_stock', label: 'Minimum' }, { key: 'stock_unit', label: 'Unit' },
    ],
    run: () =>
      query(
        `SELECT c.name AS category, p.name || ' ' || v.variant_name AS product, v.sku, i.physical_stock AS physical,
                i.reserved_stock AS reserved, (i.physical_stock - i.reserved_stock) AS available, i.min_stock, v.stock_unit
           FROM inventory i JOIN variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
           JOIN categories c ON c.id = p.category_id ORDER BY c.sort_order, p.name, v.pack_size`,
      ),
  },
  'low-stock': {
    title: 'Low-stock products',
    columns: [
      { key: 'product', label: 'Product' }, { key: 'sku', label: 'SKU' }, { key: 'available', label: 'Available' },
      { key: 'min_stock', label: 'Minimum' }, { key: 'shortfall', label: 'Below minimum by' }, { key: 'stock_unit', label: 'Unit' },
    ],
    run: () =>
      query(
        `SELECT p.name || ' ' || v.variant_name AS product, v.sku, (i.physical_stock - i.reserved_stock) AS available,
                i.min_stock, i.min_stock - (i.physical_stock - i.reserved_stock) AS shortfall, v.stock_unit
           FROM inventory i JOIN variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
          WHERE v.active AND i.min_stock > 0 AND (i.physical_stock - i.reserved_stock) <= i.min_stock
          ORDER BY shortfall DESC`,
      ),
  },
  'stock-movements': {
    title: 'Stock movement history',
    columns: [
      { key: 'when', label: 'When' }, { key: 'product', label: 'Product' }, { key: 'type', label: 'Type' },
      { key: 'physical_delta', label: 'Physical change' }, { key: 'reserved_delta', label: 'Reserved change' },
      { key: 'physical_after', label: 'Physical after' }, { key: 'order_number', label: 'Order' }, { key: 'by', label: 'By' }, { key: 'reason', label: 'Reason' },
    ],
    run: async (f) => {
      const p = new Params();
      const where = range(p, 't.created_at', f);
      if (f.retailerId) where.push(`t.retailer_id = ${p.add(f.retailerId)}`);
      return query(
        `SELECT to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS "when", p.name || ' ' || v.variant_name AS product, t.type,
                t.physical_delta, t.reserved_delta, t.physical_after, o.order_number, u.name AS by, t.reason
           FROM inventory_transactions t JOIN variants v ON v.id = t.variant_id JOIN products p ON p.id = v.product_id
           LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN users u ON u.id = t.user_id
           ${W(where)} ORDER BY t.id DESC LIMIT 5000`,
        p.list,
      );
    },
  },
  'returns-damaged': {
    title: 'Returned and damaged products',
    columns: [
      { key: 'when', label: 'When' }, { key: 'product', label: 'Product' }, { key: 'type', label: 'Type' },
      { key: 'quantity', label: 'Quantity' }, { key: 'retailer', label: 'Retailer' }, { key: 'by', label: 'By' }, { key: 'reason', label: 'Reason' },
    ],
    run: async (f) => {
      const p = new Params();
      const where = ["t.type IN ('RETURN','RETURN_DAMAGED','DAMAGED')", ...range(p, 't.created_at', f)];
      if (f.retailerId) where.push(`t.retailer_id = ${p.add(f.retailerId)}`);
      return query(
        `SELECT to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS "when", p.name || ' ' || v.variant_name AS product, t.type,
                t.quantity, r.name AS retailer, u.name AS by, t.reason
           FROM inventory_transactions t JOIN variants v ON v.id = t.variant_id JOIN products p ON p.id = v.product_id
           LEFT JOIN retailers r ON r.id = t.retailer_id LEFT JOIN users u ON u.id = t.user_id
           ${W(where)} ORDER BY t.id DESC`,
        p.list,
      );
    },
  },
};

export async function runReport(name: string, f: ReportFilters) {
  const def = REPORTS[name];
  if (!def) throw badRequest('Unknown report');
  return { name, title: def.title, columns: def.columns, rows: await def.run(f) };
}
