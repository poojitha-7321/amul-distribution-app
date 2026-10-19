import 'node:process';

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

function required(name: string, devDefault?: string): string {
  const v = process.env[name];
  if (v) return v;
  if (!isProd && devDefault !== undefined) return devDefault;
  throw new Error(`Missing required environment variable ${name}`);
}

export const config = {
  isProd,
  isTest,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL', 'postgres://postgres:postgres@localhost:54329/amul'),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  bcryptRounds: isTest ? 4 : 10,
  timezone: process.env.APP_TIMEZONE ?? 'Asia/Kolkata',
  rateLimitEnabled: !isTest && process.env.RATE_LIMIT !== 'off',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
  groqApiKey: process.env.GROQ_API_KEY ?? '',
  groqModel: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  publicUrl: (process.env.PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
  clientDist: process.env.CLIENT_DIST ?? '../client/dist',
};

if (isProd && config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}
