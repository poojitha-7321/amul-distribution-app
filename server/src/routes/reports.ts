import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { pool } from '../db.js';
import { asyncRoute, audit, dateStr, parse } from '../lib.js';
import { renderTable } from '../services/imports.js';
import { REPORTS, runReport } from '../services/reports.js';

export const reportsRouter = Router();
reportsRouter.use(requireAdmin);

reportsRouter.get('/', (_req, res) => {
  res.json({ reports: Object.entries(REPORTS).map(([name, d]) => ({ name, title: d.title })) });
});

reportsRouter.get(
  '/:name',
  asyncRoute(async (req, res) => {
    const f = parse(
      z.object({
        from: dateStr.optional(),
        to: dateStr.optional(),
        retailerId: z.coerce.number().int().positive().optional(),
        format: z.enum(['json', 'csv', 'xlsx']).default('json'),
      }),
      req.query,
    );
    const report = await runReport(String(req.params.name), f);
    if (f.format === 'json') return res.json(report);

    const file = await renderTable(
      report.columns.map((c) => c.label),
      report.rows.map((r) => report.columns.map((c) => r[c.key] ?? '')),
      f.format,
      `${report.name}-${new Date().toISOString().slice(0, 10)}`,
      report.title,
    );
    await audit(pool, req.user!.id, 'report.export', 'report', report.name, { ...f }, req.ip);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.body);
  }),
);
