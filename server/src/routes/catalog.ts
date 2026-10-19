import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { pool, query, queryOne, tx } from '../db.js';
import { asyncRoute, audit, conflict, notFound, parse } from '../lib.js';

/** Retailer + admin: browse the catalogue. */
export const catalogRouter = Router();

catalogRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const isAdmin = req.user!.role === 'admin';
    const categories = await query(
      `SELECT id, name FROM categories WHERE active ${isAdmin ? 'OR TRUE' : ''} ORDER BY sort_order, name`,
    );
    const rows = await query<any>(
      `SELECT p.id AS product_id, p.name, p.brand, p.description, p.image_url, p.category_id,
              v.id AS variant_id, v.variant_name, v.sku, v.pack_size, v.pack_size_unit, v.stock_unit,
              v.units_per_crate, v.default_order_unit, v.price, v.crate_price,
              i.physical_stock - i.reserved_stock AS available, i.min_stock
         FROM products p
         JOIN categories c ON c.id = p.category_id
         JOIN variants v ON v.product_id = p.id
         JOIN inventory i ON i.variant_id = v.id
        WHERE ($1 OR (p.active AND v.active AND c.active))
        ORDER BY c.sort_order, p.name, v.pack_size_unit, v.pack_size`,
      [isAdmin],
    );
    const products = new Map<number, any>();
    for (const r of rows) {
      let p = products.get(r.product_id);
      if (!p) {
        p = { id: r.product_id, name: r.name, brand: r.brand, description: r.description, imageUrl: r.image_url, categoryId: r.category_id, variants: [] };
        products.set(r.product_id, p);
      }
      const available = Math.max(r.available, 0);
      p.variants.push({
        id: r.variant_id, name: r.variant_name, sku: r.sku,
        packSize: Number(r.pack_size), packSizeUnit: r.pack_size_unit,
        stockUnit: r.stock_unit, unitsPerCrate: r.units_per_crate, defaultOrderUnit: r.default_order_unit,
        price: r.price, cratePrice: r.crate_price ?? (r.price !== null && r.units_per_crate ? Math.round(r.price * r.units_per_crate * 100) / 100 : null),
        available,
        stockStatus: available <= 0 ? 'out' : r.min_stock > 0 && available <= r.min_stock ? 'low' : 'in',
      });
    }
    res.json({ categories, products: [...products.values()] });
  }),
);

// ---------------------------------------------------------------------------
// Admin product management
// ---------------------------------------------------------------------------
export const adminCatalogRouter = Router();
adminCatalogRouter.use(requireAdmin);

const productSchema = z.object({
  categoryId: z.number().int().positive(),
  name: z.string().trim().min(2).max(120),
  brand: z.string().trim().min(1).max(60).default('Amul'),
  description: z.string().trim().max(500).nullish(),
  imageUrl: z.string().trim().url().max(500).nullish().or(z.literal('').transform(() => null)),
  active: z.boolean().default(true),
});

const PACK_UNITS = ['ml', 'l', 'g', 'kg', 'pcs'] as const;
const STOCK_UNITS = ['packet', 'piece', 'box', 'litre', 'kg', 'g'] as const;

export const variantSchema = z
  .object({
    variantName: z.string().trim().min(1).max(80),
    sku: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9._-]+$/, 'Letters, numbers, . _ - only'),
    packSize: z.number().positive().max(100000),
    packSizeUnit: z.enum(PACK_UNITS),
    stockUnit: z.enum(STOCK_UNITS).default('packet'),
    unitsPerCrate: z.number().int().min(2).max(10000).nullish(),
    defaultOrderUnit: z.string().trim().default('packet'),
    price: z.number().min(0).max(1000000).nullish(),
    cratePrice: z.number().min(0).max(100000000).nullish(),
    minStock: z.number().int().min(0).max(1000000).default(0),
    openingStock: z.number().int().min(0).max(10000000).default(0),
    active: z.boolean().default(true),
  })
  .refine((v) => v.defaultOrderUnit === v.stockUnit || (v.defaultOrderUnit === 'crate' && !!v.unitsPerCrate), {
    message: 'Default order unit must be the stock unit, or "crate" with a crate size configured',
    path: ['defaultOrderUnit'],
  });

adminCatalogRouter.get(
  '/products',
  asyncRoute(async (_req, res) => {
    const categories = await query('SELECT id, name, active, sort_order FROM categories ORDER BY sort_order, name');
    const rows = await query<any>(
      `SELECT p.id AS product_id, p.name, p.brand, p.description, p.image_url, p.active AS product_active, p.category_id,
              c.name AS category_name,
              v.id AS variant_id, v.variant_name, v.sku, v.pack_size, v.pack_size_unit, v.stock_unit, v.units_per_crate,
              v.default_order_unit, v.price, v.crate_price, v.active AS variant_active,
              i.physical_stock, i.reserved_stock, i.min_stock, i.opening_stock
         FROM products p
         JOIN categories c ON c.id = p.category_id
         LEFT JOIN variants v ON v.product_id = p.id
         LEFT JOIN inventory i ON i.variant_id = v.id
        ORDER BY c.sort_order, p.name, v.pack_size_unit, v.pack_size`,
    );
    const products = new Map<number, any>();
    for (const r of rows) {
      let p = products.get(r.product_id);
      if (!p) {
        p = { id: r.product_id, name: r.name, brand: r.brand, description: r.description, imageUrl: r.image_url,
              active: r.product_active, categoryId: r.category_id, categoryName: r.category_name, variants: [] };
        products.set(r.product_id, p);
      }
      if (r.variant_id) {
        p.variants.push({
          id: r.variant_id, name: r.variant_name, sku: r.sku, packSize: Number(r.pack_size), packSizeUnit: r.pack_size_unit,
          stockUnit: r.stock_unit, unitsPerCrate: r.units_per_crate, defaultOrderUnit: r.default_order_unit,
          price: r.price, cratePrice: r.crate_price, active: r.variant_active,
          physicalStock: r.physical_stock, reservedStock: r.reserved_stock, minStock: r.min_stock, openingStock: r.opening_stock,
        });
      }
    }
    res.json({ categories, products: [...products.values()] });
  }),
);

adminCatalogRouter.post(
  '/categories',
  asyncRoute(async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(60), sortOrder: z.number().int().default(0) }), req.body);
    const row = await queryOne('INSERT INTO categories (name, sort_order) VALUES ($1,$2) RETURNING *', [b.name, b.sortOrder]);
    await audit(pool, req.user!.id, 'category.create', 'category', (row as any).id, b, req.ip);
    res.status(201).json(row);
  }),
);

adminCatalogRouter.put(
  '/categories/:id',
  asyncRoute(async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(60), sortOrder: z.number().int().default(0), active: z.boolean() }), req.body);
    const row = await queryOne('UPDATE categories SET name=$2, sort_order=$3, active=$4 WHERE id=$1 RETURNING *', [Number(req.params.id), b.name, b.sortOrder, b.active]);
    if (!row) throw notFound();
    res.json(row);
  }),
);

adminCatalogRouter.post(
  '/products',
  asyncRoute(async (req, res) => {
    const b = parse(productSchema, req.body);
    const row = await tx(async (db) => {
      const r = await queryOne<any>(
        `INSERT INTO products (category_id, name, brand, description, image_url, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [b.categoryId, b.name, b.brand, b.description ?? null, b.imageUrl ?? null, b.active], db,
      );
      await audit(db, req.user!.id, 'product.create', 'product', r.id, b, req.ip);
      return r;
    });
    res.status(201).json(row);
  }),
);

adminCatalogRouter.put(
  '/products/:id',
  asyncRoute(async (req, res) => {
    const b = parse(productSchema, req.body);
    const id = Number(req.params.id);
    const row = await tx(async (db) => {
      const r = await queryOne<any>(
        `UPDATE products SET category_id=$2, name=$3, brand=$4, description=$5, image_url=$6, active=$7, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, b.categoryId, b.name, b.brand, b.description ?? null, b.imageUrl ?? null, b.active], db,
      );
      if (!r) throw notFound('Product not found');
      await audit(db, req.user!.id, 'product.update', 'product', id, b, req.ip);
      return r;
    });
    res.json(row);
  }),
);

adminCatalogRouter.post(
  '/products/:id/variants',
  asyncRoute(async (req, res) => {
    const b = parse(variantSchema, req.body);
    const productId = Number(req.params.id);
    const row = await tx(async (db) => {
      const p = await queryOne('SELECT id FROM products WHERE id = $1', [productId], db);
      if (!p) throw notFound('Product not found');
      const dup = await queryOne('SELECT id FROM variants WHERE upper(sku) = upper($1)', [b.sku], db);
      if (dup) throw conflict(`SKU ${b.sku} already exists`);
      const v = await queryOne<any>(
        `INSERT INTO variants (product_id, variant_name, sku, pack_size, pack_size_unit, stock_unit, units_per_crate,
                               default_order_unit, price, crate_price, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [productId, b.variantName, b.sku, b.packSize, b.packSizeUnit, b.stockUnit, b.unitsPerCrate ?? null,
         b.defaultOrderUnit, b.price ?? null, b.cratePrice ?? null, b.active], db,
      );
      await db.query(
        'INSERT INTO inventory (variant_id, opening_stock, physical_stock, reserved_stock, min_stock) VALUES ($1,$2,$2,0,$3)',
        [v.id, b.openingStock, b.minStock],
      );
      if (b.openingStock > 0) {
        await db.query(
          `INSERT INTO inventory_transactions (variant_id, type, physical_delta, physical_after, reserved_after, quantity, reason, user_id)
           VALUES ($1,'OPENING',$2,$2,0,$2,'Opening stock at product creation',$3)`,
          [v.id, b.openingStock, req.user!.id],
        );
      }
      await audit(db, req.user!.id, 'variant.create', 'variant', v.id, b, req.ip);
      return v;
    });
    res.status(201).json(row);
  }),
);

// Stock quantities are deliberately NOT editable here; use the inventory adjustment workflow.
adminCatalogRouter.put(
  '/variants/:id',
  asyncRoute(async (req, res) => {
    const b = parse(variantSchema, req.body);
    const id = Number(req.params.id);
    const row = await tx(async (db) => {
      const dup = await queryOne('SELECT id FROM variants WHERE upper(sku) = upper($1) AND id <> $2', [b.sku, id], db);
      if (dup) throw conflict(`SKU ${b.sku} already exists`);
      const v = await queryOne<any>(
        `UPDATE variants SET variant_name=$2, sku=$3, pack_size=$4, pack_size_unit=$5, stock_unit=$6, units_per_crate=$7,
                default_order_unit=$8, price=$9, crate_price=$10, active=$11, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, b.variantName, b.sku, b.packSize, b.packSizeUnit, b.stockUnit, b.unitsPerCrate ?? null,
         b.defaultOrderUnit, b.price ?? null, b.cratePrice ?? null, b.active], db,
      );
      if (!v) throw notFound('Variant not found');
      await db.query('UPDATE inventory SET min_stock = $2, updated_at = now() WHERE variant_id = $1', [id, b.minStock]);
      await audit(db, req.user!.id, 'variant.update', 'variant', id, b, req.ip);
      return v;
    });
    res.json(row);
  }),
);

adminCatalogRouter.patch(
  '/variants/:id/active',
  asyncRoute(async (req, res) => {
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    const v = await queryOne('UPDATE variants SET active=$2, updated_at=now() WHERE id=$1 RETURNING id, active', [Number(req.params.id), active]);
    if (!v) throw notFound();
    res.json(v);
  }),
);

adminCatalogRouter.patch(
  '/products/:id/active',
  asyncRoute(async (req, res) => {
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    const p = await queryOne('UPDATE products SET active=$2, updated_at=now() WHERE id=$1 RETURNING id, active', [Number(req.params.id), active]);
    if (!p) throw notFound();
    res.json(p);
  }),
);
