import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { asyncRoute, badRequest, parse } from '../lib.js';
import {
  buildTemplate, commitProductImport, commitStockImport, parseUpload, validateProductRows, validateStockRows,
} from '../services/imports.js';

export const importsRouter = Router();
importsRouter.use(requireAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const rowsSchema = z.array(z.record(z.string(), z.string().or(z.number()).transform(String))).min(1).max(2000);
const productMode = z.enum(['create_only', 'update_existing']).default('create_only');
const stockMode = z.enum(['opening', 'adjustment']).default('adjustment');

importsRouter.get(
  '/:kind/template',
  asyncRoute(async (req, res) => {
    const kind = z.enum(['products', 'stock']).parse(req.params.kind);
    const format = z.enum(['csv', 'xlsx']).default('csv').parse(req.query.format ?? 'csv');
    const t = await buildTemplate(kind, format);
    res.setHeader('Content-Type', t.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${t.filename}"`);
    res.send(t.body);
  }),
);

// Step 1: upload a file -> rows (client shows an editable preview)
importsRouter.post(
  '/:kind/parse',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const kind = z.enum(['products', 'stock']).parse(req.params.kind);
    if (!req.file) throw badRequest('Choose a file to upload');
    const rows = await parseUpload(req.file.buffer, req.file.originalname);
    const mode = req.query.mode;
    const validated = kind === 'products'
      ? await validateProductRows(rows, productMode.parse(mode))
      : await validateStockRows(rows, stockMode.parse(mode));
    res.json({ rows, validated });
  }),
);

// Step 2: re-validate (after the admin corrects cells in the preview)
importsRouter.post(
  '/products/validate',
  asyncRoute(async (req, res) => {
    const b = parse(z.object({ rows: rowsSchema, mode: productMode }), req.body);
    res.json({ validated: await validateProductRows(b.rows, b.mode) });
  }),
);

importsRouter.post(
  '/stock/validate',
  asyncRoute(async (req, res) => {
    const b = parse(z.object({ rows: rowsSchema, mode: stockMode }), req.body);
    res.json({ validated: await validateStockRows(b.rows, b.mode) });
  }),
);

// Step 3: commit
importsRouter.post(
  '/products/commit',
  asyncRoute(async (req, res) => {
    const b = parse(z.object({ rows: rowsSchema, mode: productMode }), req.body);
    res.json(await commitProductImport(req.user!.id, b.rows, b.mode, req.ip));
  }),
);

importsRouter.post(
  '/stock/commit',
  asyncRoute(async (req, res) => {
    const b = parse(z.object({ rows: rowsSchema, mode: stockMode, reason: z.string(), confirm: z.literal(true) }), req.body);
    res.json(await commitStockImport(req.user!.id, b.rows, b.mode, b.reason, req.ip));
  }),
);
