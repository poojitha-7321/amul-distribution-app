import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import webpush from 'web-push';

// Starts a throw-away real PostgreSQL for the whole test run (no Docker or local install required).
let pg: EmbeddedPostgres;
let dir: string;

export async function setup() {
  const port = 54800 + Math.floor(Math.random() * 100);
  dir = mkdtempSync(path.join(tmpdir(), 'amul-test-pg-'));
  pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => undefined, onError: () => undefined });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('amul_test');
  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/amul_test`;
  const vapid = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:test@example.com';
  process.env.GROQ_API_KEY = 'gsk_test';
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.PUBLIC_URL = 'https://app.example.com';
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
}

export async function teardown() {
  await pg?.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
