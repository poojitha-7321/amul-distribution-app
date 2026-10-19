import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { authenticate, clearSessionCookie, hashPassword, setSessionCookie, verifyPassword } from '../auth.js';
import { config } from '../config.js';
import { queryOne } from '../db.js';
import { asyncRoute, audit, badRequest, parse } from '../lib.js';
import { pool } from '../db.js';

export const authRouter = Router();

const noop = (_req: any, _res: any, next: any) => next();
const loginLimiter = config.rateLimitEnabled
  ? rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      // Per IP + email so one retailer's typos cannot lock out everyone behind a shared IP.
      keyGenerator: (req) => `${req.ip}|${String(req.body?.email ?? '').toLowerCase()}`,
      validate: { keyGeneratorIpFallback: false },
      message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Please try again in 15 minutes.' } },
    })
  : noop;

// Compared against when the email is unknown so response time does not reveal valid accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

const loginSchema = z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) });
const passwordSchema = z.string().min(8, 'Use at least 8 characters').max(100);

authRouter.post(
  '/login',
  loginLimiter,
  asyncRoute(async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const u = await queryOne<any>(
      `SELECT u.*, r.active AS retailer_active, r.name AS retailer_name
         FROM users u LEFT JOIN retailers r ON r.id = u.retailer_id WHERE lower(u.email) = lower($1)`,
      [email],
    );
    const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok || !u.active || (u.role === 'retailer' && !u.retailer_active)) {
      await audit(pool, u?.id ?? null, 'auth.login_failed', 'user', u?.id ?? null, { email }, req.ip);
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password' } });
    }
    setSessionCookie(res, u.id);
    await audit(pool, u.id, 'auth.login', 'user', u.id, undefined, req.ip);
    res.json({
      user: {
        id: u.id, email: u.email, name: u.name, role: u.role, retailerId: u.retailer_id,
        retailerName: u.retailer_name, mustChangePassword: u.must_change_password,
      },
    });
  }),
);

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

authRouter.post(
  '/change-password',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }), req.body);
    const row = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw badRequest('Current password is incorrect');
    }
    if (body.currentPassword === body.newPassword) throw badRequest('Choose a different password');
    await pool.query(
      'UPDATE users SET password_hash = $2, must_change_password = FALSE, password_changed_at = now() WHERE id = $1',
      [req.user!.id, await hashPassword(body.newPassword)],
    );
    await audit(pool, req.user!.id, 'auth.change_password', 'user', req.user!.id, undefined, req.ip);
    // Older tokens are now invalid; give this device a fresh session.
    setSessionCookie(res, req.user!.id);
    res.json({ ok: true });
  }),
);
