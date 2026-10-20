import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool, query, queryOne } from '../src/db.js';
import { buildTable, toIsoDate, toNumber } from '../src/services/assistant/parse.js';
import { runQuery, searchText } from '../src/services/assistant/query.js';
import { app, login, makeAdmin, makeRetailer, resetDb } from './helpers.js';

// ------------------------------------------------------------------ pure engine
const SALES = [
  ['Date', 'Product', 'Retailer', 'Qty', 'Amount'],
  ['01/09/2026', 'Amul Gold 500 ml', 'Lakshmi', '10', '₹340'],
  ['02/09/2026', 'Amul Taaza 500 ml', 'Lakshmi', '20', '₹540'],
  ['15/09/2026', 'Amul Gold 500 ml', 'Ganesh', '5', '₹170'],
  ['03/10/2026', 'Amul Gold 500 ml', 'Ganesh', '8', '₹272'],
  ['04/10/2026', 'Amul Masti Dahi 400 g', 'Balaji', '12', '₹420'],
];
const table = () => buildTable('sales', SALES)!;

describe('data parsing and query engine', () => {
  it('infers column types and cleans Indian-style values', () => {
    const t = table();
    expect(t.columns.map((c) => c.type)).toEqual(['date', 'text', 'text', 'number', 'number']);
    expect(t.rows[0]).toEqual(['2026-09-01', 'Amul Gold 500 ml', 'Lakshmi', 10, 340]);
    expect(toNumber('(1,200.50)')).toBe(-1200.5);
    expect(toNumber('Rs. 1,000')).toBe(1000);
    expect(toNumber('abc')).toBeNull();
    expect(toIsoDate('31/12/2026')).toBe('2026-12-31');
    expect(toIsoDate('32/13/2026')).toBeNull();
  });

  it('computes exact totals, groupings and rankings', () => {
    const t = table();
    const byProduct = runQuery(t, { group_by: ['Product'], metrics: [{ fn: 'sum', column: 'Amount', as: 'revenue' }, { fn: 'sum', column: 'Qty', as: 'units' }] });
    expect(byProduct.columns).toEqual(['Product', 'revenue', 'units']);
    expect(byProduct.rows[0]).toEqual(['Amul Gold 500 ml', 782, 23]); // sorted by revenue desc
    const total = runQuery(t, { metrics: [{ fn: 'sum', column: 'Amount' }, { fn: 'count' }, { fn: 'avg', column: 'Qty' }] });
    expect(total.rows[0]).toEqual([1742, 5, 11]);
    const monthly = runQuery(t, { group_by: [{ column: 'Date', by: 'month' }], metrics: [{ fn: 'sum', column: 'Amount', as: 'rev' }], order_by: { key: 'Date (month)' } });
    expect(monthly.rows).toEqual([['2026-09', 1050], ['2026-10', 692]]);
  });

  it('filters by value, text, date range and set membership', () => {
    const t = table();
    expect(runQuery(t, { filters: [{ column: 'Retailer', op: '=', value: 'ganesh' }], metrics: [{ fn: 'sum', column: 'Qty' }] }).rows[0]).toEqual([13]);
    expect(runQuery(t, { filters: [{ column: 'Product', op: 'contains', value: 'dahi' }], metrics: [{ fn: 'count' }] }).rows[0]).toEqual([1]);
    expect(runQuery(t, { filters: [{ column: 'Date', op: 'between', value: '2026-09-10', value2: '2026-10-03' }], metrics: [{ fn: 'count' }] }).rows[0]).toEqual([2]);
    expect(runQuery(t, { filters: [{ column: 'Retailer', op: 'in', value: ['Lakshmi', 'Balaji'] }], metrics: [{ fn: 'count_distinct', column: 'Retailer' }] }).rows[0]).toEqual([2]);
    expect(runQuery(t, { filters: [{ column: 'Qty', op: '>=', value: 10 }], select: ['Retailer', 'Qty'], order_by: { key: 'Qty', desc: true } }).rows).toEqual([['Lakshmi', 20], ['Balaji', 12], ['Lakshmi', 10]]);
  });

  it('rejects impossible requests with helpful messages instead of guessing', () => {
    const t = table();
    expect(() => runQuery(t, { metrics: [{ fn: 'sum', column: 'Nope' }] })).toThrow(/Unknown column "Nope".*Available columns: Date, Product/);
    expect(() => runQuery(t, { metrics: [{ fn: 'sum', column: 'Product' }] })).toThrow(/not numeric/);
    expect(() => runQuery(t, { group_by: [{ column: 'Product', by: 'month' }], metrics: [{ fn: 'count' }] })).toThrow(/not a date column/);
    expect(() => runQuery(t, { filters: [{ column: 'Qty', op: '>', value: 'abc' }] })).toThrow(/valid number/);
  });

  it('finds relevant passages in text documents', () => {
    const doc = 'Intro.\n'.repeat(200) + 'The credit period for retailers is 15 days from invoice date.\n' + 'Other text. '.repeat(200);
    const hits = searchText(doc, 'credit period retailers');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.join(' ')).toContain('15 days');
  });
});

// ------------------------------------------------------------------ API with Google + Groq mocked
let groqQueue: any[] = [];
let groqRequests: any[] = [];
let driveUploads: { name: string; body: string }[] = [];
let driveBroken = false;

const fakeIdToken = `x.${Buffer.from(JSON.stringify({ email: 'owner@gmail.com' })).toString('base64url')}.y`;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any = {}) => {
      const u = String(url);
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        const p = new URLSearchParams(init.body);
        if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') !== 'refresh-token-abc') return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: 'access-1', refresh_token: 'refresh-token-abc', expires_in: 3600, id_token: fakeIdToken });
      }
      if (u.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
      if (u.startsWith('https://www.googleapis.com/drive/v3/files')) return json({ id: 'folder-1' });
      if (u.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
        if (driveBroken) return json({ error: { message: 'quota exceeded' } }, 403);
        const body = Buffer.from(init.body).toString('utf8');
        driveUploads.push({ name: /"name":"([^"]+)"/.exec(body)?.[1] ?? '', body });
        return json({ id: `file-${driveUploads.length}`, webViewLink: `https://drive.google.com/file/d/file-${driveUploads.length}/view` });
      }
      if (u.startsWith('https://api.groq.com/')) {
        groqRequests.push(JSON.parse(init.body));
        const next = groqQueue.shift();
        if (!next) return json({ error: { message: 'no scripted reply' } }, 500);
        if (next.status) return json({ error: { message: next.message ?? 'err' } }, next.status, next.headers);
        return json({ choices: [{ message: next }] });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }),
  );
}

const toolCall = (args: unknown, name = 'query_data', id = 'call_1') => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }],
});
const csvFile = Buffer.from(SALES.map((r) => r.join(',')).join('\n'));

let admin: Awaited<ReturnType<typeof login>>;

async function connectDrive() {
  const c = await admin.post('/api/admin/assistant/drive/connect').send({});
  const state = new URL(c.body.url).searchParams.get('state')!;
  return request(app).get(`/api/drive/callback?code=abc&state=${encodeURIComponent(state)}`).redirects(0);
}

beforeEach(async () => {
  await resetDb();
  await query('TRUNCATE assistant_files, assistant_threads RESTART IDENTITY CASCADE');
  await pool.query("DELETE FROM settings WHERE key LIKE 'drive_%'");
  groqQueue = [];
  groqRequests = [];
  driveUploads = [];
  driveBroken = false;
  stubFetch();
  await makeAdmin();
  admin = await login('admin@test.local');
});
afterEach(() => vi.unstubAllGlobals());

describe('Google Drive connection', () => {
  it('connects through the OAuth callback and stores the refresh token encrypted', async () => {
    const st = await admin.get('/api/admin/assistant/status');
    expect(st.body.drive).toMatchObject({ configured: true, connected: false });
    const c = await admin.post('/api/admin/assistant/drive/connect').send({});
    const url = new URL(c.body.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toContain('drive.file');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/drive/callback');
    const cb = await connectDrive();
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/admin/assistant?drive=connected');
    const stored = await queryOne<any>("SELECT value FROM settings WHERE key = 'drive_refresh_token_enc'");
    expect(stored!.value).not.toContain('refresh-token-abc');
    const after = await admin.get('/api/admin/assistant/status');
    expect(after.body.drive).toMatchObject({ connected: true, email: 'owner@gmail.com', folderName: 'Dairy Order Desk Files' });
  });

  it('rejects forged or expired callback state', async () => {
    const r = await request(app).get('/api/drive/callback?code=abc&state=forged').redirects(0);
    expect(r.headers.location).toMatch(/drive=error/);
    expect(await queryOne("SELECT 1 FROM settings WHERE key = 'drive_refresh_token_enc'")).toBeNull();
  });

  it('disconnects and forgets the token', async () => {
    await connectDrive();
    await admin.post('/api/admin/assistant/drive/disconnect').send({});
    expect((await admin.get('/api/admin/assistant/status')).body.drive.connected).toBe(false);
  });
});

describe('uploading files', () => {
  it('still analyses the file when Drive is not connected, without calling Drive', async () => {
    const r = await admin.post('/api/admin/assistant/files').attach('file', csvFile, 'sales.csv');
    expect(r.status).toBe(201);
    expect(r.body.file).toMatchObject({ name: 'sales.csv', kind: 'table', rowCount: 5, driveLink: null });
    expect(driveUploads).toHaveLength(0);
    expect((await query('SELECT id FROM assistant_files')).length).toBe(1);
  });

  it('saves the original to Drive and the parsed data to the database', async () => {
    await connectDrive();
    const r = await admin.post('/api/admin/assistant/files').attach('file', csvFile, 'sales.csv');
    expect(r.status).toBe(201);
    expect(r.body.file).toMatchObject({ name: 'sales.csv', kind: 'table', rowCount: 5 });
    expect(r.body.file.driveLink).toContain('drive.google.com');
    expect(driveUploads).toHaveLength(1);
    expect(driveUploads[0].body).toContain('Amul Gold 500 ml'); // the real file content reached Drive
    expect(driveUploads[0].body).toContain('"parents":["folder-1"]');
    const list = await admin.get('/api/admin/assistant/files');
    expect(list.body.files[0].sheets[0].columns).toEqual(['Date', 'Product', 'Retailer', 'Qty', 'Amount']);
  });

  it('does not store the file when Drive fails, and does not call Drive for unreadable files', async () => {
    await connectDrive();
    driveBroken = true;
    const r = await admin.post('/api/admin/assistant/files').attach('file', csvFile, 'sales.csv');
    expect(r.status).toBe(502);
    expect(r.body.error.message).toMatch(/quota exceeded/);
    expect((await query('SELECT id FROM assistant_files')).length).toBe(0);
    driveBroken = false;
    const bad = await admin.post('/api/admin/assistant/files').attach('file', Buffer.from('MZ binary'), 'tool.exe');
    expect(bad.status).toBe(400);
    expect(driveUploads).toHaveLength(0);
  });

  it('accepts text documents and is admin-only', async () => {
    await connectDrive();
    const r = await admin.post('/api/admin/assistant/files').attach('file', Buffer.from('Payment terms: retailers pay within 15 days of invoice.'), 'terms.txt');
    expect(r.status).toBe(201);
    expect(r.body.file.kind).toBe('text');
    await makeRetailer('Shop A', 'a@test.local');
    const shop = await login('a@test.local');
    expect((await shop.get('/api/admin/assistant/files')).status).toBe(403);
    expect((await shop.post('/api/admin/assistant/chat').send({ message: 'hi' })).status).toBe(403);
    expect((await request(app).get('/api/admin/assistant/files')).status).toBe(401);
  });
});

describe('asking questions about uploaded files', () => {
  async function upload() {
    await connectDrive();
    const r = await admin.post('/api/admin/assistant/files').attach('file', csvFile, 'sales.csv');
    return r.body.file.id as number;
  }

  it('lets the model call the data tool and answers from exact computed numbers', async () => {
    const id = await upload();
    groqQueue = [
      toolCall({ file_id: id, group_by: ['Retailer'], metrics: [{ fn: 'sum', column: 'Amount', as: 'revenue' }], order_by: { key: 'revenue', desc: true } }),
      { role: 'assistant', content: 'Lakshmi is your top retailer with ₹880.' },
    ];
    const r = await admin.post('/api/admin/assistant/chat').send({ message: 'Which retailer buys the most?' });
    expect(r.status).toBe(200);
    expect(r.body.message.content).toContain('Lakshmi');
    expect(r.body.message.steps).toEqual([expect.objectContaining({ tool: 'query_data', ok: true })]);
    // The tool result handed back to the model contains the REAL computed figures
    const toolMsg = groqRequests[1].messages.find((m: any) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content).rows[0]).toEqual(['Lakshmi', 880]);
    // The system prompt lists the file and its columns
    expect(groqRequests[0].messages[0].content).toContain('sales.csv');
    expect(groqRequests[0].messages[0].content).toContain('Amount (number');
    expect(groqRequests[0].model).toBeTruthy();
  });

  it('keeps conversation history for follow-up questions', async () => {
    const id = await upload();
    groqQueue = [{ role: 'assistant', content: 'First answer.' }, { role: 'assistant', content: 'Second answer.' }];
    const first = await admin.post('/api/admin/assistant/chat').send({ message: 'Hello?' });
    await admin.post('/api/admin/assistant/chat').send({ threadId: first.body.threadId, message: 'And then?', fileIds: [id] });
    const history = groqRequests[1].messages.filter((m: any) => m.role !== 'system').map((m: any) => m.content);
    expect(history).toEqual(['Hello?', 'First answer.', 'And then?']);
    const thread = await admin.get(`/api/admin/assistant/threads/${first.body.threadId}`);
    expect(thread.body.messages).toHaveLength(4);
  });

  it('feeds tool errors back so the model can correct itself', async () => {
    const id = await upload();
    groqQueue = [
      toolCall({ file_id: id, metrics: [{ fn: 'sum', column: 'Revenue' }] }, 'query_data', 'c1'),
      toolCall({ file_id: id, metrics: [{ fn: 'sum', column: 'Amount' }] }, 'query_data', 'c2'),
      { role: 'assistant', content: 'Total is ₹1,742.' },
    ];
    const r = await admin.post('/api/admin/assistant/chat').send({ message: 'Total revenue?' });
    expect(r.body.message.steps.map((s: any) => s.ok)).toEqual([false, true]);
    const firstTool = groqRequests[1].messages.find((m: any) => m.role === 'tool');
    expect(JSON.parse(firstTool.content).error).toMatch(/Unknown column "Revenue"/);
    const secondTool = groqRequests[2].messages.filter((m: any) => m.role === 'tool').at(-1);
    expect(JSON.parse(secondTool.content).rows[0]).toEqual([1742]);
  });

  it('survives malformed tool-call JSON and unknown file ids', async () => {
    await upload();
    groqQueue = [toolCall('{not json'), toolCall({ file_id: 9999 }), { role: 'assistant', content: 'Sorry, I could not.' }];
    const r = await admin.post('/api/admin/assistant/chat').send({ message: 'anything' });
    expect(r.status).toBe(200);
    expect(r.body.message.steps.every((s: any) => s.ok === false)).toBe(true);
  });

  it('answers document questions through text search', async () => {
    await connectDrive();
    const up = await admin.post('/api/admin/assistant/files').attach('file', Buffer.from('Distributor agreement. Retailers must settle invoices within 15 days. Late fee is 2%.'), 'terms.txt');
    groqQueue = [toolCall({ file_id: up.body.file.id, query: 'settle invoices days' }, 'search_text'), { role: 'assistant', content: '15 days.' }];
    const r = await admin.post('/api/admin/assistant/chat').send({ message: 'What is the payment period?' });
    expect(r.body.message.steps[0]).toMatchObject({ tool: 'search_text', ok: true });
    expect(JSON.parse(groqRequests[1].messages.find((m: any) => m.role === 'tool').content).passages.join(' ')).toContain('15 days');
  });

  it('turns provider failures into clear messages', async () => {
    await upload();
    groqQueue = [{ status: 429, message: 'rate limit', headers: { 'retry-after': '17' } }];
    const limited = await admin.post('/api/admin/assistant/chat').send({ message: 'x' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.message).toMatch(/17 seconds/);
    groqQueue = [{ status: 401, message: 'bad key' }];
    expect((await admin.post('/api/admin/assistant/chat').send({ message: 'x' })).body.error.code).toBe('AI_AUTH');
    groqQueue = [{ status: 413, message: 'Request too large' }];
    expect((await admin.post('/api/admin/assistant/chat').send({ message: 'x' })).body.error.code).toBe('AI_TOO_LARGE');
  });

  it('validates input and isolates conversations per user', async () => {
    expect((await admin.post('/api/admin/assistant/chat').send({ message: '   ' })).status).toBe(400);
    expect((await admin.post('/api/admin/assistant/chat').send({ message: 'x'.repeat(2001) })).status).toBe(400);
    groqQueue = [{ role: 'assistant', content: 'ok' }];
    const mine = await admin.post('/api/admin/assistant/chat').send({ message: 'hello' });
    await makeAdmin('second@test.local');
    const other = await login('second@test.local');
    expect((await other.get(`/api/admin/assistant/threads/${mine.body.threadId}`)).status).toBe(404);
    expect((await other.post('/api/admin/assistant/chat').send({ threadId: mine.body.threadId, message: 'peek' })).status).toBe(404);
  });

  it('removes a file from the assistant but keeps the Drive copy', async () => {
    const id = await upload();
    const r = await admin.delete(`/api/admin/assistant/files/${id}`);
    expect(r.body.note).toMatch(/Google Drive is kept/);
    expect((await query('SELECT id FROM assistant_files')).length).toBe(0);
  });
});
