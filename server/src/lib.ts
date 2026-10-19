import type { Request, Response, NextFunction } from 'express';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { config } from './config.js';
import { query, queryOne, type Queryable } from './db.js';
import { later, pushToAdmins, pushToRetailer } from './services/push.js';

// ---------- errors ----------
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const forbidden = (msg = 'You are not allowed to do that') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'CONFLICT', msg, details);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: 'VALIDATION', message: 'Please check the highlighted fields', details: z.flattenError(err).fieldErrors },
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  const e = err as { type?: string; code?: string; message?: string };
  if (e?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  if (e?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: { code: 'FILE_TOO_LARGE', message: 'File is too large (max 5 MB)' } });
  }
  // Postgres unique violation / check violation fallbacks
  if (e?.code === '23505') {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with these details already exists' } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
}

// ---------- validation ----------
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data);
}

// ---------- misc ----------
export const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** Today's date (YYYY-MM-DD) in the business timezone. */
export function todayStr(offsetDays = 0, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  if (!offsetDays) return parts;
  const d = new Date(`${parts}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export async function getSetting(key: string, db?: Queryable): Promise<string> {
  const row = await queryOne<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key], db);
  return row?.value ?? '';
}

export async function getSettings(db?: Queryable): Promise<Record<string, string>> {
  const rows = await query<{ key: string; value: string }>('SELECT key, value FROM settings', [], db);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---------- audit ----------
export async function audit(
  db: Queryable,
  userId: number | null,
  action: string,
  entity: string,
  entityId: string | number | null,
  details?: unknown,
  ip?: string,
) {
  await db.query(
    'INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [userId, action, entity, entityId === null ? null : String(entityId), details ? JSON.stringify(details) : null, ip ?? null],
  );
}

// ---------- notifications ----------
export async function notifyAdmins(db: Queryable, title: string, body?: string, link?: string) {
  await db.query('INSERT INTO notifications (for_admins, title, body, link) VALUES (TRUE,$1,$2,$3)', [title, body ?? null, link ?? null]);
  later(() => pushToAdmins({ title, body, url: link }));
}

export async function notifyRetailerUsers(db: Queryable, retailerId: number, title: string, body?: string, link?: string) {
  await db.query(
    `INSERT INTO notifications (user_id, title, body, link)
     SELECT id, $2, $3, $4 FROM users WHERE retailer_id = $1 AND active`,
    [retailerId, title, body ?? null, link ?? null],
  );
  later(() => pushToRetailer(retailerId, { title, body, url: link }));
}

export function csvSafe(v: unknown): unknown {
  // Neutralise spreadsheet formula injection in exports.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) return `'${v}`;
  return v;
}
