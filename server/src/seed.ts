import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthUser } from './auth.js';
import { hashPassword } from './auth.js';
import { config } from './config.js';
import { pool, queryOne, query } from './db.js';
import { migrate } from './migrate.js';
import { todayStr } from './lib.js';
import { confirmDelivery, createOrder, transitionOrder } from './services/orders.js';

// Development-only demo credentials. Never used in production unless you explicitly set the env vars.
export const DEMO = {
  adminEmail: 'admin@amul-demo.local',
  adminPassword: 'Admin@12345',
  retailerPassword: 'Retailer@123',
};

interface SeedVariant {
  sku: string; variant: string; size: number; unit: 'ml' | 'l' | 'g' | 'kg'; crate: number | null;
  price: number; stock: number; min: number;
}
interface SeedProduct { category: string; name: string; description: string; variants: SeedVariant[] }

// SAMPLE catalogue. Pack sizes, crate sizes and prices are placeholders: replace with your actual
// distributor price list (Admin > Products, or Admin > Import).
const SAMPLE_CATALOGUE: SeedProduct[] = [
  { category: 'Milk', name: 'Amul Gold', description: 'Full cream milk (sample)', variants: [
    { sku: 'MLK-GOLD-500', variant: '500 ml pouch', size: 500, unit: 'ml', crate: 24, price: 34, stock: 480, min: 96 },
    { sku: 'MLK-GOLD-1L', variant: '1 litre pouch', size: 1, unit: 'l', crate: 12, price: 68, stock: 240, min: 48 },
  ] },
  { category: 'Milk', name: 'Amul Taaza', description: 'Toned milk (sample)', variants: [
    { sku: 'MLK-TAAZA-500', variant: '500 ml pouch', size: 500, unit: 'ml', crate: 24, price: 27, stock: 720, min: 120 },
    { sku: 'MLK-TAAZA-1L', variant: '1 litre pouch', size: 1, unit: 'l', crate: 12, price: 54, stock: 300, min: 60 },
  ] },
  { category: 'Milk', name: 'Amul Shakti', description: 'Standardised milk (sample)', variants: [
    { sku: 'MLK-SHAKTI-500', variant: '500 ml pouch', size: 500, unit: 'ml', crate: 24, price: 31, stock: 360, min: 72 },
  ] },
  { category: 'Milk', name: 'Amul Cow Milk', description: 'Cow milk (sample)', variants: [
    { sku: 'MLK-COW-500', variant: '500 ml pouch', size: 500, unit: 'ml', crate: 24, price: 30, stock: 240, min: 48 },
  ] },
  { category: 'Milk', name: 'Amul Slim & Trim', description: 'Double toned milk (sample)', variants: [
    { sku: 'MLK-SLIM-500', variant: '500 ml pouch', size: 500, unit: 'ml', crate: 24, price: 25, stock: 120, min: 48 },
  ] },
  { category: 'Curd / Dahi', name: 'Amul Masti Dahi', description: 'Fresh curd (sample)', variants: [
    { sku: 'CRD-MASTI-200', variant: '200 g cup', size: 200, unit: 'g', crate: 30, price: 22, stock: 300, min: 60 },
    { sku: 'CRD-MASTI-400', variant: '400 g pouch', size: 400, unit: 'g', crate: 20, price: 35, stock: 400, min: 80 },
    { sku: 'CRD-MASTI-1KG', variant: '1 kg pouch', size: 1, unit: 'kg', crate: 10, price: 80, stock: 150, min: 30 },
  ] },
  { category: 'Curd / Dahi', name: 'Amul Probiotic Dahi', description: 'Probiotic curd (sample)', variants: [
    { sku: 'CRD-PROBIO-400', variant: '400 g cup', size: 400, unit: 'g', crate: 12, price: 45, stock: 24, min: 36 },
  ] },
];

export async function seedBase(adminEmail: string, adminPassword: string) {
  await migrate();
  for (const [i, name] of ['Milk', 'Curd / Dahi'].entries()) {
    await pool.query('INSERT INTO categories (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, i]);
  }
  const existing = await queryOne('SELECT id FROM users WHERE lower(email) = lower($1)', [adminEmail]);
  if (!existing) {
    await pool.query("INSERT INTO users (email, name, password_hash, role) VALUES ($1,'Distributor Admin',$2,'admin')", [
      adminEmail, await hashPassword(adminPassword),
    ]);
  }
}

export async function seedCatalogue() {
  for (const p of SAMPLE_CATALOGUE) {
    const cat = await queryOne<{ id: number }>('SELECT id FROM categories WHERE name = $1', [p.category]);
    const prod = await queryOne<{ id: number }>(
      `INSERT INTO products (category_id, name, brand, description) VALUES ($1,$2,'Amul',$3)
       ON CONFLICT (category_id, brand, name) DO UPDATE SET description = EXCLUDED.description RETURNING id`,
      [cat!.id, p.name, p.description],
    );
    for (const v of p.variants) {
      if (await queryOne('SELECT id FROM variants WHERE upper(sku) = upper($1)', [v.sku])) continue;
      const row = await queryOne<{ id: number }>(
        `INSERT INTO variants (product_id, variant_name, sku, pack_size, pack_size_unit, stock_unit, units_per_crate,
                               default_order_unit, price)
         VALUES ($1,$2,$3,$4,$5,'packet',$6,'packet',$7) RETURNING id`,
        [prod!.id, v.variant, v.sku, v.size, v.unit, v.crate, v.price],
      );
      await pool.query('INSERT INTO inventory (variant_id, opening_stock, physical_stock, min_stock) VALUES ($1,$2,$2,$3)', [row!.id, v.stock, v.min]);
      await pool.query(
        `INSERT INTO inventory_transactions (variant_id, type, physical_delta, physical_after, reserved_after, quantity, reason)
         VALUES ($1,'OPENING',$2,$2,0,$2,'Seed opening stock')`,
        [row!.id, v.stock],
      );
    }
  }
}

const DEMO_RETAILERS = [
  { name: 'Sri Lakshmi Dairy Store', owner: 'Lakshmi Devi', email: 'lakshmi@retailer-demo.local', phone: '9000000001', address: 'Main Road, Visakhapatnam' },
  { name: 'Ganesh Milk Point', owner: 'Ganesh Rao', email: 'ganesh@retailer-demo.local', phone: '9000000002', address: 'MVP Colony, Visakhapatnam' },
  { name: 'Balaji Kirana & Dairy', owner: 'Balaji Reddy', email: 'balaji@retailer-demo.local', phone: '9000000003', address: 'Gajuwaka, Visakhapatnam' },
];

async function asUser(email: string): Promise<AuthUser> {
  const u = await queryOne<any>(
    `SELECT u.id, u.email, u.name, u.role, u.retailer_id, r.name AS retailer_name
       FROM users u LEFT JOIN retailers r ON r.id = u.retailer_id WHERE lower(u.email) = lower($1)`, [email]);
  return { id: u.id, email: u.email, name: u.name, role: u.role, retailerId: u.retailer_id, retailerName: u.retailer_name, mustChangePassword: false };
}

export async function seedDemo() {
  const exists = await queryOne('SELECT id FROM retailers LIMIT 1');
  if (exists) return console.log('Demo retailers already exist; skipping demo data.');
  for (const r of DEMO_RETAILERS) {
    const ret = await queryOne<{ id: number }>(
      'INSERT INTO retailers (name, owner_name, phone, address) VALUES ($1,$2,$3,$4) RETURNING id', [r.name, r.owner, r.phone, r.address]);
    await pool.query("INSERT INTO users (email, name, password_hash, role, retailer_id) VALUES ($1,$2,$3,'retailer',$4)", [
      r.email, r.owner, await hashPassword(DEMO.retailerPassword), ret!.id]);
  }
  const admin = await asUser(DEMO.adminEmail);
  const a = await asUser(DEMO_RETAILERS[0].email);
  const b = await asUser(DEMO_RETAILERS[1].email);
  const c = await asUser(DEMO_RETAILERS[2].email);
  const v = async (sku: string) => (await queryOne<{ id: number }>('SELECT id FROM variants WHERE sku = $1', [sku]))!.id;
  const tomorrow = todayStr(1);

  const o1 = await createOrder(a, { deliveryDate: tomorrow, items: [
    { variantId: await v('MLK-TAAZA-500'), unit: 'crate', quantity: 2 }, { variantId: await v('CRD-MASTI-400'), unit: 'packet', quantity: 20 }] });
  const o2 = await createOrder(b, { deliveryDate: tomorrow, items: [
    { variantId: await v('MLK-GOLD-500'), unit: 'packet', quantity: 36 }, { variantId: await v('MLK-GOLD-1L'), unit: 'packet', quantity: 12 }] });
  const o3 = await createOrder(c, { deliveryDate: tomorrow, items: [{ variantId: await v('CRD-MASTI-1KG'), unit: 'crate', quantity: 1 }] });
  const o4 = await createOrder(a, { deliveryDate: todayStr(2), items: [{ variantId: await v('MLK-SHAKTI-500'), unit: 'packet', quantity: 24 }] });

  await transitionOrder(admin, o2.id, 'accept');
  await transitionOrder(admin, o3.id, 'accept');
  await transitionOrder(admin, o3.id, 'prepare');
  await transitionOrder(admin, o3.id, 'ready');
  await transitionOrder(admin, o4.id, 'accept');
  await transitionOrder(admin, o4.id, 'prepare');
  await transitionOrder(admin, o4.id, 'ready');
  await confirmDelivery(admin, o4.id, {});
  void o1;
  const n = await query('SELECT count(*) FROM orders');
  console.log(`Seeded demo retailers and ${(n[0] as any).count} sample orders.`);
}

async function main() {
  const demo = !config.isProd || process.env.SEED_DEMO === 'true';
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? (demo ? DEMO.adminEmail : '');
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? (demo ? DEMO.adminPassword : '');
  if (!adminEmail || adminPassword.length < 10) {
    throw new Error('In production set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 10 chars) to create the first admin.');
  }
  await seedBase(adminEmail, adminPassword);
  if (demo || process.env.SEED_SAMPLE_CATALOG === 'true') await seedCatalogue();
  if (demo) await seedDemo();
  console.log(`Admin account ready: ${adminEmail}`);
  if (demo) console.log(`Demo logins: ${DEMO.adminEmail} / ${DEMO.adminPassword}; ${DEMO_RETAILERS[0].email} / ${DEMO.retailerPassword}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => pool.end())
    .catch(async (e) => {
      console.error(e);
      await pool.end();
      process.exit(1);
    });
}
