import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { authenticate, requireAdmin } from './auth.js';
import { config } from './config.js';
import { errorHandler, forbidden } from './lib.js';
import { authRouter } from './routes/auth.js';
import { adminCatalogRouter, catalogRouter } from './routes/catalog.js';
import { importsRouter } from './routes/imports.js';
import { inventoryRouter } from './routes/inventory.js';
import { auditRouter, dashboardRouter, notificationsRouter, settingsRouter } from './routes/misc.js';
import { ordersRouter } from './routes/orders.js';
import { pushRouter } from './routes/push.js';
import { reportsRouter } from './routes/reports.js';
import { retailersRouter } from './routes/retailers.js';

/** Rejects state-changing requests that come from another origin (defence in depth on top of SameSite=Strict). */
function sameOriginOnly(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return next(forbidden('Cross-origin request blocked'));
    } catch {
      return next(forbidden('Cross-origin request blocked'));
    }
  }
  next();
}

export function createApp() {
  const app = express();
  if (config.isProd) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'img-src': ["'self'", 'data:', 'https:'],
          'connect-src': ["'self'"],
          'worker-src': ["'self'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.use(sameOriginOnly);
  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.use('/auth', authRouter);

  // Everything below requires a logged-in user.
  api.use(authenticate);
  api.use('/catalog', catalogRouter);
  api.use('/orders', ordersRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/push', pushRouter);
  api.use('/settings', settingsRouter);

  // Admin-only areas (each router also enforces requireAdmin itself).
  api.use('/admin/retailers', requireAdmin, retailersRouter);
  api.use('/admin/inventory', requireAdmin, inventoryRouter);
  api.use('/admin/imports', requireAdmin, importsRouter);
  api.use('/admin/reports', requireAdmin, reportsRouter);
  api.use('/admin/audit', requireAdmin, auditRouter);
  api.use('/admin', requireAdmin, adminCatalogRouter);

  api.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  app.use('/api', api);

  // Built React app (PWA) is served by the same process in production.
  const dist = path.resolve(process.cwd(), config.clientDist);
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
