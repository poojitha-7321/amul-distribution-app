import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import type { PoolClient } from 'pg';
import { query, queryOne, tx } from '../db.js';
import { audit, badRequest, csvSafe } from '../lib.js';
import { reasonSchema, setPhysicalStockInTx } from './inventory.js';

export type RawRow = Record<string, string>;

const norm = (h: string) => h.toString().trim().toLowerCase().replace(/[\s-]+/g, '_');

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as any;
    if (o.richText) return o.richText.map((t: any) => t.text).join('').trim();
    if (o.text !== undefined) return String(o.text).trim();
    if (o.result !== undefined) return String(o.result).trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

/** Reads the first sheet of an .xlsx, or a .csv, into header-normalised string rows. */
export async function parseUpload(buffer: Buffer, filename: string): Promise<RawRow[]> {
  const lower = filename.toLowerCase();
  let table: string[][];
  if (lower.endsWith('.csv')) {
    table = parseCsv(buffer.toString('utf8').replace(/^﻿/, ''), {
      skip_empty_lines: true, relax_column_count: true, trim: true,
    }) as string[][];
  } else if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('The workbook has no sheets');
    table = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values as unknown[]).slice(1).map(cellText);
      table.push(vals);
    });
  } else {
    throw badRequest('Upload a .csv or .xlsx file');
  }
  if (table.length < 2) throw badRequest('The file has no data rows');
  if (table.length > 2001) throw badRequest('Too many rows (max 2000 per import)');
  const headers = table[0].map(norm);
  return table.slice(1).map((r) => {
    const o: RawRow = {};
    headers.forEach((h, i) => { if (h) o[h] = (r[i] ?? '').toString().trim(); });
    return o;
  }).filter((r) => Object.values(r).some((v) => v !== ''));
}

// ---------------------------------------------------------------------------
// Product catalogue import (never touches stock quantities)
// ---------------------------------------------------------------------------
export const PRODUCT_COLUMNS = [
  'category', 'product_name', 'brand', 'variant_name', 'pack_size', 'pack_size_unit', 'stock_unit',
  'units_per_crate', 'default_order_unit', 'sku', 'price', 'crate_price', 'min_stock', 'active', 'description', 'image_url',
];
const PACK_UNITS = ['ml', 'l', 'g', 'kg', 'pcs'];
const STOCK_UNITS = ['packet', 'piece', 'box', 'litre', 'kg', 'g'];

export interface ValidatedProductRow {
  rowNumber: number;
  data: RawRow;
  errors: string[];
  action: 'create' | 'update' | 'error';
}

const num = (s: string | undefined) => (s === undefined || s === '' ? null : Number(s));
const bool = (s: string | undefined) => {
  if (s === undefined || s === '') return true;
  const v = s.toLowerCase();
  if (['true', 'yes', 'y', '1', 'active'].includes(v)) return true;
  if (['false', 'no', 'n', '0', 'inactive'].includes(v)) return false;
  return null;
};

export async function validateProductRows(
  rows: RawRow[],
  mode: 'create_only' | 'update_existing',
  db: PoolClient | null = null,
): Promise<ValidatedProductRow[]> {
  const cats = await query<{ id: number; name: string }>('SELECT id, name FROM categories', [], db ?? undefined);
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
  const existing = await query<{ sku: string }>('SELECT upper(sku) AS sku FROM variants', [], db ?? undefined);
  const existingSkus = new Set(existing.map((e) => e.sku));
  const seen = new Map<string, number>();

  return rows.map((raw, idx) => {
    const d: RawRow = {};
    for (const k of PRODUCT_COLUMNS) d[k] = (raw[k] ?? '').toString().trim();
    const errors: string[] = [];
    for (const k of ['category', 'product_name', 'variant_name', 'pack_size', 'pack_size_unit', 'sku']) {
      if (!d[k]) errors.push(`${k} is required`);
    }
    if (d.category && !catByName.has(d.category.toLowerCase())) errors.push(`Unknown category "${d.category}"`);
    const ps = num(d.pack_size);
    if (d.pack_size && (ps === null || !(ps > 0) || Number.isNaN(ps))) errors.push('pack_size must be a positive number');
    if (d.pack_size_unit && !PACK_UNITS.includes(d.pack_size_unit.toLowerCase())) errors.push(`Invalid pack_size_unit "${d.pack_size_unit}" (use ${PACK_UNITS.join(', ')})`);
    const su = (d.stock_unit || 'packet').toLowerCase();
    if (!STOCK_UNITS.includes(su)) errors.push(`Invalid stock_unit "${d.stock_unit}" (use ${STOCK_UNITS.join(', ')})`);
    const upc = num(d.units_per_crate);
    if (d.units_per_crate && (upc === null || !Number.isInteger(upc) || upc < 2)) errors.push('units_per_crate must be a whole number of 2 or more');
    const dou = (d.default_order_unit || su).toLowerCase();
    if (dou !== su && !(dou === 'crate' && upc)) errors.push('default_order_unit must equal stock_unit, or be "crate" with units_per_crate set');
    for (const k of ['price', 'crate_price', 'min_stock']) {
      const v = num(d[k]);
      if (d[k] && (v === null || Number.isNaN(v) || v < 0)) errors.push(`${k} must be a number, 0 or more`);
    }
    if (d.min_stock && !Number.isInteger(Number(d.min_stock))) errors.push('min_stock must be a whole number');
    if (bool(d.active) === null) errors.push('active must be yes/no');
    if (d.sku && !/^[A-Za-z0-9._-]{2,40}$/.test(d.sku)) errors.push('sku may only contain letters, numbers, . _ - (2-40 chars)');

    let action: ValidatedProductRow['action'] = 'create';
    if (d.sku) {
      const key = d.sku.toUpperCase();
      if (seen.has(key)) errors.push(`Duplicate SKU in file (first used on row ${seen.get(key)})`);
      else seen.set(key, idx + 2);
      if (existingSkus.has(key)) {
        if (mode === 'create_only') errors.push('SKU already exists (choose "update existing" to modify it)');
        else action = 'update';
      }
    }
    return { rowNumber: idx + 2, data: d, errors, action: errors.length ? 'error' : action };
  });
}

export async function commitProductImport(userId: number, rows: RawRow[], mode: 'create_only' | 'update_existing', ip?: string) {
  return tx(async (db) => {
    const validated = await validateProductRows(rows, mode, db);
    const cats = await query<{ id: number; name: string }>('SELECT id, name FROM categories', [], db);
    const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
    let created = 0;
    let updated = 0;
    for (const r of validated) {
      if (r.action === 'error') continue;
      const d = r.data;
      const su = (d.stock_unit || 'packet').toLowerCase();
      const dou = (d.default_order_unit || su).toLowerCase();
      const upc = d.units_per_crate ? Number(d.units_per_crate) : null;
      const brand = d.brand || 'Amul';
      const catId = catByName.get(d.category.toLowerCase())!;
      let product = await queryOne<{ id: number }>(
        'SELECT id FROM products WHERE category_id=$1 AND lower(brand)=lower($2) AND lower(name)=lower($3)',
        [catId, brand, d.product_name], db,
      );
      if (!product) {
        product = await queryOne<{ id: number }>(
          'INSERT INTO products (category_id, name, brand, description, image_url) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [catId, d.product_name, brand, d.description || null, d.image_url || null], db,
        );
      }
      const vals = [
        product!.id, d.variant_name, d.sku, Number(d.pack_size), d.pack_size_unit.toLowerCase(), su, upc, dou,
        d.price ? Number(d.price) : null, d.crate_price ? Number(d.crate_price) : null, bool(d.active) ?? true,
      ];
      if (r.action === 'create') {
        const v = await queryOne<{ id: number }>(
          `INSERT INTO variants (product_id, variant_name, sku, pack_size, pack_size_unit, stock_unit, units_per_crate,
                                 default_order_unit, price, crate_price, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, vals, db,
        );
        // New variants start with zero stock; quantities come only from the stock workflow.
        await db.query('INSERT INTO inventory (variant_id, min_stock) VALUES ($1,$2)', [v!.id, d.min_stock ? Number(d.min_stock) : 0]);
        created++;
      } else {
        const v = await queryOne<{ id: number }>(
          `UPDATE variants SET product_id=$1, variant_name=$2, pack_size=$4, pack_size_unit=$5, stock_unit=$6,
                  units_per_crate=$7, default_order_unit=$8, price=$9, crate_price=$10, active=$11, updated_at=now()
            WHERE upper(sku)=upper($3) RETURNING id`, vals, db,
        );
        if (d.min_stock) await db.query('UPDATE inventory SET min_stock=$2 WHERE variant_id=$1', [v!.id, Number(d.min_stock)]);
        updated++;
      }
    }
    const skipped = validated.filter((r) => r.action === 'error').length;
    await audit(db, userId, 'import.products', 'import', null, { mode, created, updated, skipped }, ip);
    return { created, updated, skipped, rows: validated };
  });
}

// ---------------------------------------------------------------------------
// Stock import (opening stock / stock-take) - explicit confirmation + audit trail
// ---------------------------------------------------------------------------
export const STOCK_COLUMNS = ['sku', 'quantity'];

export interface ValidatedStockRow {
  rowNumber: number;
  sku: string;
  productName?: string;
  currentStock?: number;
  newStock?: number;
  delta?: number;
  errors: string[];
}

export async function validateStockRows(rows: RawRow[], mode: 'opening' | 'adjustment', db: PoolClient | null = null): Promise<ValidatedStockRow[]> {
  const seen = new Set<string>();
  const out: ValidatedStockRow[] = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const raw = rows[idx];
    const sku = (raw.sku ?? '').toString().trim();
    const qtyText = (raw.quantity ?? '').toString().trim();
    const errors: string[] = [];
    const row: ValidatedStockRow = { rowNumber: idx + 2, sku, errors };
    if (!sku) errors.push('sku is required');
    const qty = Number(qtyText);
    if (qtyText === '' || !Number.isInteger(qty) || qty < 0) errors.push('quantity must be a whole number, 0 or more');
    if (sku) {
      if (seen.has(sku.toUpperCase())) errors.push('Duplicate SKU in file');
      seen.add(sku.toUpperCase());
      const v = await queryOne<any>(
        `SELECT v.id, p.name || ' ' || v.variant_name AS name, i.physical_stock, i.reserved_stock,
                (SELECT count(*) FROM inventory_transactions t WHERE t.variant_id = v.id) AS tx_count
           FROM variants v JOIN products p ON p.id = v.product_id JOIN inventory i ON i.variant_id = v.id
          WHERE upper(v.sku) = upper($1)`, [sku], db ?? undefined,
      );
      if (!v) errors.push('Unknown SKU');
      else {
        row.productName = v.name;
        row.currentStock = v.physical_stock;
        if (!errors.length) {
          row.newStock = qty;
          row.delta = qty - v.physical_stock;
          if (qty < v.reserved_stock) errors.push(`Cannot go below ${v.reserved_stock} units reserved for accepted orders`);
          if (mode === 'opening' && v.tx_count > 0) errors.push('Opening stock can only be set before any stock movement; use "adjustment"');
        }
      }
    }
    out.push(row);
  }
  return out;
}

export async function commitStockImport(userId: number, rows: RawRow[], mode: 'opening' | 'adjustment', reason: unknown, ip?: string) {
  const why = reasonSchema(reason);
  return tx(async (db) => {
    const validated = await validateStockRows(rows, mode, db);
    const bad = validated.filter((r) => r.errors.length);
    // Stock imports are all-or-nothing so a stock-take never half-applies.
    if (bad.length) throw badRequest(`${bad.length} row(s) have errors. Fix them and try again.`, { rows: validated });
    let changed = 0;
    for (const r of validated) {
      const v = await queryOne<{ id: number }>('SELECT id FROM variants WHERE upper(sku) = upper($1)', [r.sku], db);
      if (r.delta !== 0 || mode === 'opening') changed++;
      await setPhysicalStockInTx(db, userId, v!.id, r.newStock!, `${mode === 'opening' ? 'Opening stock' : 'Stock import'}: ${why}`, mode === 'opening' ? 'OPENING' : 'ADJUSTMENT', ip);
    }
    await audit(db, userId, 'import.stock', 'import', null, { mode, rows: validated.length, changed, reason: why }, ip);
    return { rows: validated.length, changed };
  });
}

// ---------------------------------------------------------------------------
// Templates & error reports
// ---------------------------------------------------------------------------
export const PRODUCT_SAMPLE_ROWS = [
  ['Milk', 'Amul Taaza', 'Amul', '500 ml pouch', '500', 'ml', 'packet', '24', 'crate', 'SAMPLE-TAAZA-500', '27', '', '48', 'yes', 'Toned milk', ''],
  ['Curd / Dahi', 'Amul Masti Dahi', 'Amul', '400 g pouch', '400', 'g', 'packet', '', 'packet', 'SAMPLE-DAHI-400', '35', '', '24', 'yes', '', ''],
];

export async function buildTemplate(kind: 'products' | 'stock', format: 'csv' | 'xlsx'): Promise<{ body: Buffer; contentType: string; filename: string }> {
  const header = kind === 'products' ? PRODUCT_COLUMNS : STOCK_COLUMNS;
  const rows = kind === 'products' ? PRODUCT_SAMPLE_ROWS : [['SAMPLE-TAAZA-500', '120'], ['SAMPLE-DAHI-400', '60']];
  return renderTable(header, rows, format, `${kind}-import-template`);
}

export async function renderTable(
  header: string[],
  rows: unknown[][],
  format: 'csv' | 'xlsx',
  basename: string,
  sheetName = 'Sheet1',
): Promise<{ body: Buffer; contentType: string; filename: string }> {
  const safeRows = rows.map((r) => r.map(csvSafe));
  if (format === 'csv') {
    return {
      body: Buffer.from('﻿' + stringify([header, ...safeRows]), 'utf8'),
      contentType: 'text/csv; charset=utf-8',
      filename: `${basename}.csv`,
    };
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.addRow(header).font = { bold: true };
  for (const r of safeRows) ws.addRow(r as any[]);
  ws.columns.forEach((c) => { c.width = 18; });
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return { body: buf, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${basename}.xlsx` };
}
