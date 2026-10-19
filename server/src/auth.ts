import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { queryOne } from './db.js';
import { AppError, forbidden } from './lib.js';

export const COOKIE = 'amul_session';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'retailer';
  retailerId: number | null;
  retailerName: string | null;
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, config.bcryptRounds);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export function signSession(userId: number): string {
  return jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: `${config.sessionHours}h` });
}

export function setSessionCookie(res: Response, userId: number) {
  res.cookie(COOKIE, signSession(userId), {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProd,
    maxAge: config.sessionHours * 3600 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE, { path: '/' });
}

/** Loads the user fresh from the database on every request so that
 *  deactivation and password resets take effect immediately. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Please log in');
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    } catch {
      throw new AppError(401, 'UNAUTHENTICATED', 'Session expired, please log in again');
    }
    const row = await queryOne<any>(
      `SELECT u.id, u.email, u.name, u.role, u.retailer_id, u.active, u.must_change_password,
              u.password_changed_at, r.name AS retailer_name, r.active AS retailer_active
         FROM users u LEFT JOIN retailers r ON r.id = u.retailer_id
        WHERE u.id = $1`,
      [Number(payload.sub)],
    );
    if (!row || !row.active || (row.role === 'retailer' && !row.retailer_active)) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Account is disabled');
    }
    // Tokens issued before the last password change are no longer valid.
    if ((payload.iat ?? 0) < Math.floor(new Date(row.password_changed_at).getTime() / 1000)) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Password changed, please log in again');
    }
    req.user = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      retailerId: row.retailer_id,
      retailerName: row.retailer_name,
      mustChangePassword: row.must_change_password,
    };
    next();
  } catch (e) {
    next(e);
  }
}

export const requireRole =
  (...roles: AuthUser['role'][]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(401, 'UNAUTHENTICATED', 'Please log in'));
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

export const requireAdmin = requireRole('admin');
export const requireRetailer = requireRole('retailer');
