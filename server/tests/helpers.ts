import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword, type AuthUser } from '../src/auth.js';
import { pool, queryOne } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { todayStr } from '../src/lib.js';

export const app = createApp();
export const PASSWORD = 'Passw0rd!x';

export async function resetDb() {
  await migrate();
  await pool.query(`TRUNCATE audit_logs, notifications, inventory_transactions, delivery_items, deliveries,
    order_status_history, order_items, orders, inventory, variants, products, categories, users, retailers
    RESTART IDENTITY CASCADE`);
  await pool.query(`UPDATE settings SET value='block' WHERE key='insufficient_stock_policy'`);
  await pool.query(`UPDATE settings SET value='ACCEPTED' WHERE key='retailer_cancel_until'`);
  await pool.query('ALTER SEQUENCE order_number_seq RESTART WITH 1001');
}

export async function makeAdmin(email = 'admin@test.local') {
  const r = await queryOne<{ id: number }>(
    "INSERT INTO users (email, name, password_hash, role) VALUES ($1,'Admin',$2,'admin') RETURNING id",
    [email, await hashPassword(PASSWORD)],
  );
  return { id: r!.id, email };
}

export async function makeRetailer(name: string, email: string) {
  const ret = await queryOne<{ id: number }>('INSERT INTO retailers (name) VALUES ($1) RETURNING id', [name]);
  const u = await queryOne<{ id: number }>(
    "INSERT INTO users (email, name, password_hash, role, retailer_id) VALUES ($1,$2,$3,'retailer',$4) RETURNING id",
    [email, name, await hashPassword(PASSWORD), ret!.id],
  );
  return { retailerId: ret!.id, userId: u!.id, email };
}

export async function makeVariant(opts: {
  sku: string; name?: string; stock?: number; min?: number; price?: number | null; crate?: number | null; category?: string;
}) {
  const catName = opts.category ?? 'Milk';
  let cat = await queryOne<{ id: number }>('SELECT id FROM categories WHERE name = $1', [catName]);
  if (!cat) cat = await queryOne<{ id: number }>('INSERT INTO categories (name) VALUES ($1) RETURNING id', [catName]);
  const prod = await queryOne<{ id: number }>(
    `INSERT INTO products (category_id, name, brand) VALUES ($1,$2,'Amul')
     ON CONFLICT (category_id, brand, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [cat!.id, opts.name ?? `Product ${opts.sku}`],
  );
  const crate = opts.crate === undefined ? 12 : opts.crate;
  const v = await queryOne<{ id: number }>(
    `INSERT INTO variants (product_id, variant_name, sku, pack_size, pack_size_unit, stock_unit, units_per_crate, price)
     VALUES ($1,'500 ml pouch',$2,500,'ml','packet',$3,$4) RETURNING id`,
    [prod!.id, opts.sku, crate, opts.price === undefined ? 25 : opts.price],
  );
  const stock = opts.stock ?? 100;
  await pool.query('INSERT INTO inventory (variant_id, opening_stock, physical_stock, min_stock) VALUES ($1,$2,$2,$3)', [v!.id, stock, opts.min ?? 0]);
  return v!.id;
}

export async function login(email: string, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed ${res.status}: ${JSON.stringify(res.body)}`);
  return agent;
}

export const tomorrow = () => todayStr(1);

export async function stock(variantId: number) {
  return (await queryOne<{ physical_stock: number; reserved_stock: number }>(
    'SELECT physical_stock, reserved_stock FROM inventory WHERE variant_id = $1', [variantId]))!;
}

export function placeOrder(agent: ReturnType<typeof request.agent>, items: { variantId: number; unit?: string; quantity: number }[], extra: Record<string, unknown> = {}) {
  return agent.post('/api/orders').send({
    deliveryDate: tomorrow(),
    items: items.map((i) => ({ unit: 'packet', ...i })),
    ...extra,
  });
}

export type { AuthUser };
