import type { Cell, Column, DataTable } from './parse.js';
import { toIsoDate, toNumber } from './parse.js';

/**
 * Safe, read-only query engine. The AI never writes code or SQL: it fills in this
 * structured plan and WE compute the numbers, so figures are exact.
 */
export type Op = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'in' | 'between' | 'is_empty' | 'not_empty';
export interface Filter { column: string; op: Op; value?: unknown; value2?: unknown }
export type Fn = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct';
export interface Metric { fn: Fn; column?: string; as?: string }
export type GroupBy = string | { column: string; by?: 'day' | 'month' | 'year' | 'weekday' };
export interface QueryPlan {
  table?: string;
  filters?: Filter[];
  group_by?: GroupBy[];
  metrics?: Metric[];
  select?: string[];
  order_by?: { key: string; desc?: boolean };
  limit?: number;
}
export interface QueryResult {
  columns: string[];
  rows: Cell[][];
  matched_rows: number;
  shown_rows: number;
  note?: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export class QueryError extends Error {}

function findColumn(t: DataTable, name: string): { idx: number; col: Column } {
  const want = String(name ?? '').trim().toLowerCase();
  let idx = t.columns.findIndex((c) => c.name.toLowerCase() === want);
  if (idx < 0) idx = t.columns.findIndex((c) => c.name.toLowerCase().includes(want) && want.length >= 3);
  if (idx < 0) throw new QueryError(`Unknown column "${name}". Available columns: ${t.columns.map((c) => c.name).join(', ')}`);
  return { idx, col: t.columns[idx] };
}

export function pickTable(tables: DataTable[], name?: string): DataTable {
  if (!name) return tables[0];
  const t = tables.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? tables.find((x) => x.name.toLowerCase().includes(name.toLowerCase()));
  if (!t) throw new QueryError(`Unknown sheet "${name}". Sheets: ${tables.map((x) => x.name).join(', ')}`);
  return t;
}

function coerce(col: Column, v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (col.type === 'number') return toNumber(v);
  if (col.type === 'date') return toIsoDate(v) ?? (typeof v === 'string' ? v : null);
  return String(v).toLowerCase();
}

function matches(f: Filter, t: DataTable): (row: Cell[]) => boolean {
  const { idx, col } = findColumn(t, f.column);
  const op = f.op;
  if (op === 'is_empty') return (r) => r[idx] === null;
  if (op === 'not_empty') return (r) => r[idx] !== null;
  const a = coerce(col, f.value);
  if (op === 'in') {
    const list = (Array.isArray(f.value) ? f.value : [f.value]).map((x) => coerce(col, x));
    return (r) => { const c = coerce(col, r[idx]); return c !== null && list.includes(c); };
  }
  if (op === 'between') {
    const b = coerce(col, f.value2);
    if (a === null || b === null) throw new QueryError('between needs value and value2');
    return (r) => { const c = coerce(col, r[idx]); return c !== null && c >= a && c <= b; };
  }
  if (a === null) throw new QueryError(`Filter on "${f.column}" needs a valid ${col.type} value`);
  if (op === 'contains') return (r) => r[idx] !== null && String(r[idx]).toLowerCase().includes(String(a));
  return (r) => {
    const c = coerce(col, r[idx]);
    if (c === null) return false;
    switch (op) {
      case '=': return c === a;
      case '!=': return c !== a;
      case '>': return c > a;
      case '>=': return c >= a;
      case '<': return c < a;
      case '<=': return c <= a;
      default: throw new QueryError(`Unsupported operator "${op}"`);
    }
  };
}

function groupKey(t: DataTable, g: GroupBy): { label: string; get: (r: Cell[]) => Cell } {
  const spec = typeof g === 'string' ? { column: g } : g;
  const { idx, col } = findColumn(t, spec.column);
  const by = (spec as any).by as string | undefined;
  if (!by) return { label: col.name, get: (r) => r[idx] };
  if (col.type !== 'date') throw new QueryError(`"${col.name}" is not a date column, so it cannot be grouped by ${by}`);
  return {
    label: `${col.name} (${by})`,
    get: (r) => {
      const d = r[idx];
      if (typeof d !== 'string') return null;
      if (by === 'year') return d.slice(0, 4);
      if (by === 'month') return d.slice(0, 7);
      if (by === 'weekday') return WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];
      return d;
    },
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

export function runQuery(t: DataTable, plan: QueryPlan): QueryResult {
  const limit = Math.max(1, Math.min(Number(plan.limit) || 20, 100));
  const preds = (plan.filters ?? []).map((f) => matches(f, t));
  const rows = t.rows.filter((r) => preds.every((p) => p(r)));
  const metrics = plan.metrics ?? [];
  const groups = (plan.group_by ?? []).map((g) => groupKey(t, g));

  // Raw rows
  if (!metrics.length && !groups.length) {
    const idxs = plan.select?.length ? plan.select.map((c) => findColumn(t, c).idx) : t.columns.map((_, i) => i);
    let out = rows.map((r) => idxs.map((i) => r[i]));
    const cols = idxs.map((i) => t.columns[i].name);
    if (plan.order_by) {
      const k = cols.findIndex((c) => c.toLowerCase() === plan.order_by!.key.toLowerCase());
      if (k < 0) throw new QueryError(`order_by must be one of: ${cols.join(', ')}`);
      out = sortRows(out, k, !!plan.order_by.desc);
    }
    return { columns: cols, rows: out.slice(0, limit), matched_rows: rows.length, shown_rows: Math.min(out.length, limit) };
  }

  const defs = (metrics.length ? metrics : [{ fn: 'count' as Fn }]).map((m) => {
    if (m.fn !== 'count' && !m.column) throw new QueryError(`Metric "${m.fn}" needs a column`);
    const c = m.column ? findColumn(t, m.column) : null;
    if (c && ['sum', 'avg'].includes(m.fn) && c.col.type !== 'number') throw new QueryError(`Cannot ${m.fn} "${c.col.name}" because it is not numeric`);
    return { m, c, label: m.as || (c ? `${m.fn}_${c.col.name}` : m.fn) };
  });

  const buckets = new Map<string, { key: Cell[]; rows: Cell[][] }>();
  for (const r of rows) {
    const key = groups.map((g) => g.get(r));
    const id = JSON.stringify(key);
    let b = buckets.get(id);
    if (!b) buckets.set(id, (b = { key, rows: [] }));
    b.rows.push(r);
  }
  if (!groups.length && !buckets.size) buckets.set('[]', { key: [], rows: [] });

  const out: Cell[][] = [...buckets.values()].map((b) => [
    ...b.key,
    ...defs.map(({ m, c }) => {
      if (m.fn === 'count' && !c) return b.rows.length;
      const vals = b.rows.map((r) => r[c!.idx]).filter((v) => v !== null);
      switch (m.fn) {
        case 'count': return vals.length;
        case 'count_distinct': return new Set(vals.map(String)).size;
        case 'sum': return round((vals as number[]).reduce((s, v) => s + v, 0));
        case 'avg': return vals.length ? round((vals as number[]).reduce((s, v) => s + v, 0) / vals.length) : null;
        case 'min': return vals.length ? vals.reduce((a, v) => (v < a ? v : a)) : null;
        case 'max': return vals.length ? vals.reduce((a, v) => (v > a ? v : a)) : null;
        default: throw new QueryError(`Unsupported metric "${m.fn}"`);
      }
    }),
  ]);
  const cols = [...groups.map((g) => g.label), ...defs.map((d) => d.label)];
  let sorted = out;
  const ob = plan.order_by ?? (groups.length && defs.length ? { key: defs[0].label, desc: true } : undefined);
  if (ob) {
    const k = cols.findIndex((c) => c.toLowerCase() === ob.key.toLowerCase());
    if (k < 0) throw new QueryError(`order_by must be one of: ${cols.join(', ')}`);
    sorted = sortRows(out, k, !!ob.desc);
  }
  const note = sorted.length > limit ? `Showing top ${limit} of ${sorted.length} groups` : undefined;
  return { columns: cols, rows: sorted.slice(0, limit), matched_rows: rows.length, shown_rows: Math.min(sorted.length, limit), note };
}

function sortRows(rows: Cell[][], k: number, desc: boolean): Cell[][] {
  return [...rows].sort((a, b) => {
    const x = a[k], y = b[k];
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * (desc ? -1 : 1);
  });
}

/** Compact description of a table for the model's context. */
export function describeTable(t: DataTable): string {
  const cols = t.columns.map((c, i) => {
    const vals = t.rows.map((r) => r[i]).filter((v) => v !== null);
    if (c.type === 'number' && vals.length) {
      const nums = vals as number[];
      return `${c.name} (number, ${Math.min(...nums)}..${Math.max(...nums)})`;
    }
    if (c.type === 'date' && vals.length) {
      const ds = (vals as string[]).slice().sort();
      return `${c.name} (date, ${ds[0]}..${ds[ds.length - 1]})`;
    }
    const distinct = [...new Set(vals.map(String))];
    return distinct.length <= 8 ? `${c.name} (text: ${distinct.join(' | ')})` : `${c.name} (text, ${distinct.length} distinct)`;
  });
  return `sheet "${t.name}": ${t.rows.length} rows${t.truncated ? ' (truncated)' : ''}; columns: ${cols.join('; ')}`;
}

// ---------------------------------------------------------------- text search (PDF / text files)
export function searchText(text: string, query: string, maxChunks = 4): string[] {
  const size = 900;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size - 150) chunks.push(text.slice(i, i + size));
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  if (!terms.length) return chunks.slice(0, maxChunks);
  const df = terms.map((t) => chunks.filter((c) => c.toLowerCase().includes(t)).length || 1);
  const scored = chunks.map((c, i) => {
    const low = c.toLowerCase();
    const score = terms.reduce((s, t, k) => s + (low.split(t).length - 1) * Math.log(1 + chunks.length / df[k]), 0);
    return { c, i, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, maxChunks).sort((a, b) => a.i - b.i).map((s) => s.c);
}
