import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { config } from '../config.js';
import { pool, query, queryOne } from '../db.js';
import { asyncRoute, audit, badRequest, notFound, parse } from '../lib.js';
import { runAgent, loadFiles } from '../services/assistant/agent.js';
import { aiConfigured } from '../services/assistant/groq.js';
import { parseUploadedFile } from '../services/assistant/parse.js';
import { authUrl, completeConnect, disconnectDrive, driveStatus, uploadToDrive } from '../services/drive.js';

export const assistantRouter = Router();
assistantRouter.use(requireAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const chatLimiter = config.rateLimitEnabled
  ? rateLimit({
      windowMs: 10 * 60 * 1000,
      limit: 40,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => `user-${req.user?.id ?? 'anon'}`,
      validate: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many questions in a short time. Please wait a few minutes.' } },
    })
  : (_req: any, _res: any, next: any) => next();

assistantRouter.get(
  '/status',
  asyncRoute(async (_req, res) => {
    res.json({ ai: { configured: aiConfigured(), model: config.groqModel }, drive: await driveStatus() });
  }),
);

// ---------------------------------------------------------------- Google Drive connection
assistantRouter.post('/drive/connect', (req, res) => {
  res.json({ url: authUrl(req.user!.id) });
});
assistantRouter.post(
  '/drive/disconnect',
  asyncRoute(async (req, res) => {
    await disconnectDrive(req.user!.id, req.ip);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- files
const fileSummary = (r: any) => ({
  id: r.id, name: r.name, kind: r.kind, sizeBytes: r.size_bytes, rowCount: r.row_count, driveLink: r.drive_link, createdAt: r.created_at,
  sheets: r.sheets ?? null,
});

assistantRouter.get(
  '/files',
  asyncRoute(async (_req, res) => {
    const rows = await query(
      `SELECT id, name, kind, size_bytes, row_count, drive_link, created_at,
              (SELECT jsonb_agg(jsonb_build_object('name', t->>'name', 'columns', (SELECT jsonb_agg(c->>'name') FROM jsonb_array_elements(t->'columns') c)))
                 FROM jsonb_array_elements(COALESCE(tables, '[]'::jsonb)) t) AS sheets
         FROM assistant_files ORDER BY id DESC LIMIT 200`,
    );
    res.json({ files: rows.map(fileSummary) });
  }),
);

assistantRouter.post(
  '/files',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw badRequest('Choose a file to upload');
    const { originalname, buffer, mimetype, size } = req.file;
    // Fail fast on unreadable files, before anything is written to Drive.
    const parsed = await parseUploadedFile(buffer, originalname);
    // Drive is optional: without a connection the file is still analysable, just not backed up.
    const drive = (await driveStatus()).connected ? await uploadToDrive(originalname, mimetype || 'application/octet-stream', buffer) : null;
    const row = await queryOne<any>(
      `INSERT INTO assistant_files (name, mime_type, kind, size_bytes, drive_file_id, drive_link, tables, text_content, row_count, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, name, kind, size_bytes, row_count, drive_link, created_at`,
      [
        originalname, mimetype, parsed.kind, size, drive?.id ?? null, drive?.link ?? null,
        parsed.kind === 'table' ? JSON.stringify(parsed.tables) : null,
        parsed.kind === 'text' ? parsed.text : null,
        parsed.rowCount, req.user!.id,
      ],
    );
    await audit(pool, req.user!.id, 'assistant.upload', 'assistant_file', row.id, { name: originalname, size, driveId: drive?.id ?? null }, req.ip);
    const truncated = parsed.kind === 'table' && parsed.tables.some((t) => t.truncated);
    res.status(201).json({
      file: fileSummary({ ...row, sheets: parsed.kind === 'table' ? parsed.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name) })) : null }),
      warning: truncated ? 'This file is very large, so only the first rows were loaded for analysis.' : undefined,
    });
  }),
);

assistantRouter.delete(
  '/files/:id',
  asyncRoute(async (req, res) => {
    const r = await queryOne('DELETE FROM assistant_files WHERE id = $1 RETURNING id', [Number(req.params.id)]);
    if (!r) throw notFound('File not found');
    await audit(pool, req.user!.id, 'assistant.delete_file', 'assistant_file', req.params.id as string, undefined, req.ip);
    res.json({ ok: true, note: 'Removed from the assistant. The copy in Google Drive is kept.' });
  }),
);

// ---------------------------------------------------------------- chat
assistantRouter.get(
  '/threads',
  asyncRoute(async (req, res) => {
    const rows = await query('SELECT id, title, updated_at FROM assistant_threads WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50', [req.user!.id]);
    res.json({ threads: rows });
  }),
);

assistantRouter.get(
  '/threads/:id',
  asyncRoute(async (req, res) => {
    const t = await queryOne('SELECT id, title FROM assistant_threads WHERE id = $1 AND user_id = $2', [Number(req.params.id), req.user!.id]);
    if (!t) throw notFound('Conversation not found');
    const messages = await query('SELECT id, role, content, meta, created_at FROM assistant_messages WHERE thread_id = $1 ORDER BY id', [Number(req.params.id)]);
    res.json({ thread: t, messages });
  }),
);

assistantRouter.delete(
  '/threads/:id',
  asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM assistant_threads WHERE id = $1 AND user_id = $2', [Number(req.params.id), req.user!.id]);
    res.json({ ok: true });
  }),
);

assistantRouter.post(
  '/chat',
  chatLimiter,
  asyncRoute(async (req, res) => {
    const b = parse(
      z.object({
        threadId: z.number().int().positive().optional(),
        message: z.string().trim().min(1, 'Type a question').max(2000),
        fileIds: z.array(z.number().int().positive()).max(8).optional(),
      }),
      req.body,
    );
    let threadId = b.threadId;
    let history: { role: 'user' | 'assistant'; content: string }[] = [];
    if (threadId) {
      const t = await queryOne('SELECT id FROM assistant_threads WHERE id = $1 AND user_id = $2', [threadId, req.user!.id]);
      if (!t) throw notFound('Conversation not found');
      history = await query('SELECT role, content FROM assistant_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT 8', [threadId]);
      history.reverse();
    } else {
      const t = await queryOne<{ id: number }>('INSERT INTO assistant_threads (user_id, title) VALUES ($1,$2) RETURNING id', [req.user!.id, b.message.slice(0, 60)]);
      threadId = t!.id;
    }
    const files = await loadFiles(b.fileIds);
    const result = await runAgent({ question: b.message, history, files });

    await pool.query('INSERT INTO assistant_messages (thread_id, role, content) VALUES ($1,$2,$3)', [threadId, 'user', b.message]);
    const saved = await queryOne<any>(
      'INSERT INTO assistant_messages (thread_id, role, content, meta) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
      [threadId, 'assistant', result.answer, JSON.stringify({ steps: result.steps, files: files.map((f) => ({ id: f.id, name: f.name })) })],
    );
    await pool.query('UPDATE assistant_threads SET updated_at = now() WHERE id = $1', [threadId]);
    res.json({ threadId, message: { id: saved.id, role: 'assistant', content: result.answer, steps: result.steps, createdAt: saved.created_at } });
  }),
);

// ---------------------------------------------------------------- OAuth callback (public: Google redirects the browser here)
export const driveCallbackRouter = Router();
driveCallbackRouter.get(
  '/callback',
  asyncRoute(async (req, res) => {
    const back = (q: string) => res.redirect(`/admin/assistant?${q}`);
    if (typeof req.query.error === 'string') return back(`drive=error&msg=${encodeURIComponent(req.query.error)}`);
    try {
      await completeConnect(String(req.query.code ?? ''), String(req.query.state ?? ''), req.ip);
      return back('drive=connected');
    } catch (e: any) {
      return back(`drive=error&msg=${encodeURIComponent(e?.message ?? 'Could not connect Google Drive')}`);
    }
  }),
);
