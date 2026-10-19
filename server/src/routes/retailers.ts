import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { hashPassword, requireAdmin } from '../auth.js';
import { pool, query, queryOne, tx } from '../db.js';
import { asyncRoute, audit, conflict, notFound, parse } from '../lib.js';

export const retailersRouter = Router();
retailersRouter.use(requireAdmin);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export function tempPassword(len = 10): string {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

const retailerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(30).nullish(),
  address: z.string().trim().max(300).nullish(),
});

retailersRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    const rows = await query(
      `SELECT r.id, r.name, r.owner_name, r.phone, r.address, r.active, r.created_at,
              u.id AS user_id, u.email, u.active AS user_active,
              (SELECT count(*) FROM orders o WHERE o.retailer_id = r.id) AS order_count
         FROM retailers r
         LEFT JOIN LATERAL (SELECT * FROM users WHERE retailer_id = r.id ORDER BY id LIMIT 1) u ON TRUE
        ORDER BY r.name`,
    );
    res.json({ retailers: rows });
  }),
);

retailersRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const b = parse(retailerSchema.extend({ email: z.string().trim().email().max(200), contactName: z.string().trim().max(120).optional() }), req.body);
    const password = tempPassword();
    const created = await tx(async (db) => {
      const dup = await queryOne('SELECT id FROM users WHERE lower(email) = lower($1)', [b.email], db);
      if (dup) throw conflict('That email is already registered');
      const r = await queryOne<any>(
        'INSERT INTO retailers (name, owner_name, phone, address) VALUES ($1,$2,$3,$4) RETURNING *',
        [b.name, b.ownerName ?? null, b.phone ?? null, b.address ?? null], db,
      );
      const u = await queryOne<any>(
        `INSERT INTO users (email, name, password_hash, role, retailer_id, must_change_password)
         VALUES ($1,$2,$3,'retailer',$4,TRUE) RETURNING id`,
        [b.email, b.contactName || b.ownerName || b.name, await hashPassword(password), r.id], db,
      );
      await audit(db, req.user!.id, 'retailer.create', 'retailer', r.id, { name: b.name, email: b.email }, req.ip);
      return { retailer: r, userId: u.id };
    });
    // The temporary password is shown once, here, and never stored in plain text.
    res.status(201).json({ ...created, temporaryPassword: password });
  }),
);

retailersRouter.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const b = parse(retailerSchema, req.body);
    const r = await queryOne(
      'UPDATE retailers SET name=$2, owner_name=$3, phone=$4, address=$5, updated_at=now() WHERE id=$1 RETURNING *',
      [Number(req.params.id), b.name, b.ownerName ?? null, b.phone ?? null, b.address ?? null],
    );
    if (!r) throw notFound('Retailer not found');
    await audit(pool, req.user!.id, 'retailer.update', 'retailer', req.params.id as string, b, req.ip);
    res.json(r);
  }),
);

retailersRouter.patch(
  '/:id/active',
  asyncRoute(async (req, res) => {
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    const r = await queryOne('UPDATE retailers SET active=$2, updated_at=now() WHERE id=$1 RETURNING id, active', [Number(req.params.id), active]);
    if (!r) throw notFound('Retailer not found');
    await audit(pool, req.user!.id, active ? 'retailer.activate' : 'retailer.deactivate', 'retailer', req.params.id as string, undefined, req.ip);
    res.json(r);
  }),
);

retailersRouter.post(
  '/:id/reset-password',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const user = await queryOne<any>('SELECT id FROM users WHERE retailer_id = $1 ORDER BY id LIMIT 1', [id]);
    if (!user) throw notFound('Retailer login not found');
    const password = tempPassword();
    await pool.query(
      'UPDATE users SET password_hash=$2, must_change_password=TRUE, password_changed_at=now() WHERE id=$1',
      [user.id, await hashPassword(password)],
    );
    await audit(pool, req.user!.id, 'retailer.reset_password', 'retailer', id, undefined, req.ip);
    res.json({ temporaryPassword: password });
  }),
);
