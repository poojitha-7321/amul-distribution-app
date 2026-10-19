import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { badRequest } from '../../lib.js';

export type ColType = 'number' | 'date' | 'text';
export interface Column {
  name: string;
  type: ColType;
}
export type Cell = string | number | null;
export interface DataTable {
  name: string;
  columns: Column[];
  rows: Cell[][];
  truncated: boolean;
}
export type ParsedFile =
  | { kind: 'table'; tables: DataTable[]; rowCount: number }
  | { kind: 'text'; text: string; rowCount: 0 };

export const MAX_ROWS = 50_000;
export const MAX_COLS = 100;
export const MAX_TEXT = 1_500_000;
const MAX_TABLE_JSON = 8_000_000;

// ---------------------------------------------------------------- cell cleaning
const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/;
const DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/; // Indian convention: day first
const pad = (n: number) => String(n).padStart(2, '0');

export function toIsoDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = ISO.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = DMY.exec(s);
  if (m) return validDate(+m[3], +m[2], +m[1]);
  return null;
}
function validDate(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[₹$€£,\s]/g, '').replace(/^rs\.?/i, '').replace(/%$/, '');
  if (!/^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function excelValue(v: ExcelJS.CellValue): string | number | Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const o = v as any;
  if (o.richText) return o.richText.map((t: any) => t.text).join('');
  if (o.result !== undefined) return excelValue(o.result);
  if (o.text !== undefined) return String(o.text);
  if (o.error) return null;
  return String(v);
}

function inferColumn(values: unknown[]): ColType {
  const filled = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (filled.length === 0) return 'text';
  const sample = filled.slice(0, 500);
  const dates = sample.filter((v) => toIsoDate(v) !== null).length;
  if (dates / sample.length >= 0.9) return 'date';
  const nums = sample.filter((v) => toNumber(v) !== null).length;
  if (nums / sample.length >= 0.9) return 'number';
  return 'text';
}

/** Turns raw grid (first row = header) into a typed table. */
export function buildTable(name: string, grid: unknown[][]): DataTable | null {
  const rowsIn = grid.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
  if (rowsIn.length < 2) return null;
  const width = Math.min(MAX_COLS, Math.max(...rowsIn.slice(0, 50).map((r) => r.length)));
  const seen = new Map<string, number>();
  const names = Array.from({ length: width }, (_, i) => {
    let n = String(rowsIn[0][i] ?? '').trim() || `Column ${i + 1}`;
    const k = n.toLowerCase();
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    if (c > 1) n = `${n} (${c})`;
    return n.slice(0, 80);
  });
  let body = rowsIn.slice(1);
  let truncated = false;
  if (body.length > MAX_ROWS) { body = body.slice(0, MAX_ROWS); truncated = true; }
  const types: ColType[] = names.map((_, i) => inferColumn(body.map((r) => r[i])));
  const rows: Cell[][] = body.map((r) =>
    names.map((_, i) => {
      const v = r[i];
      if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
      if (types[i] === 'date') return toIsoDate(v);
      if (types[i] === 'number') return toNumber(v);
      return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim().slice(0, 500);
    }),
  );
  return { name, columns: names.map((n, i) => ({ name: n, type: types[i] })), rows, truncated };
}

// ---------------------------------------------------------------- file readers
function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/, 5).join('\n');
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 } as Record<string, number>;
  for (const ch of head) if (ch in counts) counts[ch]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export async function parseUploadedFile(buffer: Buffer, filename: string): Promise<ParsedFile> {
  const lower = filename.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';

  if (ext === '.csv' || ext === '.tsv') {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    let grid: string[][];
    try {
      grid = parseCsv(text, { delimiter: detectDelimiter(text), relax_column_count: true, skip_empty_lines: true, trim: true }) as string[][];
    } catch {
      throw badRequest('Could not read this CSV file. Check that it is a valid comma-separated file.');
    }
    const t = buildTable(filename.replace(/\.[^.]+$/, ''), grid);
    if (!t) throw badRequest('The file has no data rows');
    return finish([t]);
  }

  if (ext === '.xlsx') {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as any);
    } catch {
      throw badRequest('Could not read this Excel file. Save it as .xlsx and try again.');
    }
    const tables: DataTable[] = [];
    for (const ws of wb.worksheets) {
      const grid: unknown[][] = [];
      ws.eachRow({ includeEmpty: false }, (row) => grid.push((row.values as ExcelJS.CellValue[]).slice(1).map(excelValue)));
      const t = buildTable(ws.name, grid);
      if (t) tables.push(t);
      if (tables.length >= 10) break;
    }
    if (!tables.length) throw badRequest('The workbook has no sheets with data');
    return finish(tables);
  }

  if (ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    let text = '';
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      text = (await extractText(pdf, { mergePages: true })).text as string;
    } catch {
      throw badRequest('Could not read this PDF. Scanned (image-only) PDFs are not supported.');
    }
    return textResult(text, 'This PDF has no readable text (it may be a scanned image).');
  }

  if (['.txt', '.md', '.json', '.log'].includes(ext)) {
    let text = buffer.toString('utf8');
    if (ext === '.json') {
      try { text = JSON.stringify(JSON.parse(text), null, 1); } catch { /* keep raw */ }
    }
    return textResult(text, 'The file is empty');
  }

  throw badRequest('Unsupported file type. Upload .csv, .xlsx, .pdf, .txt, .md or .json');
}

function textResult(text: string, emptyMsg: string): ParsedFile {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length < 3) throw badRequest(emptyMsg);
  return { kind: 'text', text: clean.slice(0, MAX_TEXT), rowCount: 0 };
}

function finish(tables: DataTable[]): ParsedFile {
  // Keep the stored JSON bounded (free database tier is small).
  while (JSON.stringify(tables).length > MAX_TABLE_JSON) {
    const biggest = tables.reduce((a, b) => (a.rows.length >= b.rows.length ? a : b));
    if (biggest.rows.length < 100) throw badRequest('This file is too large to analyse. Please upload a smaller file.');
    biggest.rows = biggest.rows.slice(0, Math.floor(biggest.rows.length * 0.7));
    biggest.truncated = true;
  }
  return { kind: 'table', tables, rowCount: tables.reduce((s, t) => s + t.rows.length, 0) };
}
