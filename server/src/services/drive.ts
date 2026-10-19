import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool, query } from '../db.js';
import { AppError, audit, badRequest, conflict } from '../lib.js';

const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Dairy Order Desk Files';
const KEYS = ['drive_refresh_token_enc', 'drive_folder_id', 'drive_email'] as const;

export const driveConfigured = () => !!(config.googleClientId && config.googleClientSecret);
const redirectUri = () => `${config.publicUrl}/api/drive/callback`;

// ---------------------------------------------------------------- token encryption (at rest)
const key = () => crypto.createHash('sha256').update(`${config.jwtSecret}:drive-token`).digest();

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- stored connection
async function readSettings(): Promise<Record<string, string>> {
  const rows = await query<{ key: string; value: string }>('SELECT key, value FROM settings WHERE key = ANY($1)', [KEYS as unknown as string[]]);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
async function writeSetting(k: string, v: string) {
  await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
}

export async function driveStatus() {
  const s = await readSettings();
  return {
    configured: driveConfigured(),
    connected: !!s.drive_refresh_token_enc,
    email: s.drive_email ?? null,
    folderName: s.drive_folder_id ? FOLDER_NAME : null,
    folderUrl: s.drive_folder_id ? `https://drive.google.com/drive/folders/${s.drive_folder_id}` : null,
  };
}

// ---------------------------------------------------------------- OAuth connect flow
export function authUrl(userId: number): string {
  if (!driveConfigured()) throw new AppError(503, 'DRIVE_NOT_CONFIGURED', 'Google Drive is not set up on the server yet (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  // `state` proves who started the flow: the callback arrives from google.com, so the SameSite=Strict session cookie is not sent.
  const state = jwt.sign({ sub: String(userId), purpose: 'drive-connect' }, config.jwtSecret, { expiresIn: '10m' });
  const p = new URLSearchParams({
    client_id: config.googleClientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...params }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(502, 'DRIVE_AUTH', `Google rejected the request: ${json.error_description ?? json.error ?? res.status}`);
  return json;
}

export async function completeConnect(code: string, state: string, ip?: string): Promise<number> {
  let userId: number;
  try {
    const p = jwt.verify(state, config.jwtSecret) as jwt.JwtPayload;
    if (p.purpose !== 'drive-connect') throw new Error('bad purpose');
    userId = Number(p.sub);
  } catch {
    throw badRequest('This Google connection link has expired. Please start again from the Assistant page.');
  }
  const tok = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (!tok.refresh_token) {
    throw badRequest('Google did not return offline access. Remove "Dairy Order Desk" from your Google account permissions (myaccount.google.com/permissions) and connect again.');
  }
  let email = '';
  try {
    email = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1], 'base64url').toString()).email ?? '';
  } catch { /* email is cosmetic */ }
  cachedToken = { value: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
  const folderId = await createFolder(tok.access_token);
  await writeSetting('drive_refresh_token_enc', encrypt(tok.refresh_token));
  await writeSetting('drive_folder_id', folderId);
  await writeSetting('drive_email', email);
  await audit(pool, userId, 'drive.connect', 'drive', null, { email }, ip);
  return userId;
}

export async function disconnectDrive(userId: number, ip?: string) {
  const s = await readSettings();
  if (s.drive_refresh_token_enc) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(s.drive_refresh_token_enc))}`, { method: 'POST' });
    } catch { /* best effort */ }
  }
  await pool.query('DELETE FROM settings WHERE key = ANY($1)', [KEYS as unknown as string[]]);
  cachedToken = null;
  await audit(pool, userId, 'drive.disconnect', 'drive', null, undefined, ip);
}

// ---------------------------------------------------------------- Drive API
let cachedToken: { value: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now()) return cachedToken.value;
  const s = await readSettings();
  if (!s.drive_refresh_token_enc) throw conflict('Google Drive is not connected. Connect it from the Assistant page first.');
  let refresh: string;
  try { refresh = decrypt(s.drive_refresh_token_enc); } catch { throw conflict('Stored Google connection is unreadable. Please reconnect Google Drive.'); }
  const tok = await tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' }).catch((e) => {
    throw conflict(`Google Drive connection expired or was revoked. Please reconnect. (${e.message})`);
  });
  cachedToken = { value: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function createFolder(token: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.id) throw new AppError(502, 'DRIVE_ERROR', `Could not create the Drive folder: ${json.error?.message ?? res.status}`);
  return json.id;
}

export async function uploadToDrive(name: string, mimeType: string, data: Buffer): Promise<{ id: string; link: string }> {
  const send = async (folderId: string) => {
    const token = await accessToken();
    const boundary = `amul${crypto.randomBytes(12).toString('hex')}`;
    const meta = JSON.stringify({ name, parents: [folderId] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  };

  const s = await readSettings();
  let folderId = s.drive_folder_id;
  if (!folderId) throw conflict('Google Drive is not connected. Connect it from the Assistant page first.');
  let res = await send(folderId);
  if (res.status === 404) {
    // The user deleted our folder in Drive: make a fresh one and retry once.
    folderId = await createFolder(await accessToken());
    await writeSetting('drive_folder_id', folderId);
    res = await send(folderId);
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.id) throw new AppError(502, 'DRIVE_ERROR', `Google Drive upload failed: ${json.error?.message ?? res.status}`);
  return { id: json.id, link: json.webViewLink ?? `https://drive.google.com/file/d/${json.id}/view` };
}
