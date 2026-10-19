import { useRef, useState } from 'react';
import { Download, FileSpreadsheet } from 'lucide-react';
import { api, download, post } from '../../api';
import { Button, Card, Input, PageHeader, Pill, Select, Table, Td, Th, useToast, cx } from '../../ui';

type Kind = 'products' | 'stock';
const PRODUCT_COLS = ['category', 'product_name', 'brand', 'variant_name', 'pack_size', 'pack_size_unit', 'stock_unit', 'units_per_crate', 'default_order_unit', 'sku', 'price', 'crate_price', 'min_stock', 'active'];
const STOCK_COLS = ['sku', 'quantity'];

function errorCsv(rows: Record<string, string>[], validated: any[], cols: string[]) {
  const esc = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [[...cols, 'errors'].map(esc).join(',')];
  validated.forEach((v, i) => { if (v.errors.length) lines.push([...cols.map((c) => rows[i]?.[c] ?? ''), v.errors.join('; ')].map(esc).join(',')); });
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = 'import-errors.csv'; a.click(); URL.revokeObjectURL(url);
}

function Importer({ kind }: { kind: Kind }) {
  const toast = useToast();
  const cols = kind === 'products' ? PRODUCT_COLS : STOCK_COLS;
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState(kind === 'products' ? 'create_only' : 'adjustment');
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [validated, setValidated] = useState<any[]>([]);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const bad = validated.filter((v) => v.errors.length).length;

  const parseFile = async (file: File) => {
    setBusy(true); setResult(null);
    try {
      const form = new FormData(); form.append('file', file);
      const r = await api(`/admin/imports/${kind}/parse?mode=${mode}`, { form });
      setRows(r.rows); setValidated(r.validated);
    } catch (e) { toast.error(e); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const revalidate = async (next = rows!) => {
    setBusy(true);
    try { setValidated((await post(`/admin/imports/${kind}/validate`, { rows: next, mode })).validated); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const commit = async () => {
    setBusy(true);
    try {
      const body: any = { rows, mode };
      if (kind === 'stock') { body.reason = reason; body.confirm = true; }
      const r = await post(`/admin/imports/${kind}/commit`, body);
      setResult(r); setRows(null); setValidated([]); setConfirm(false); setReason('');
      toast.success(kind === 'products' ? `Imported: ${r.created} new, ${r.updated} updated` : `Stock updated for ${r.rows} products`);
    } catch (e: any) {
      toast.error(e);
      if (e.details?.rows) setValidated(e.details.rows);
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => download(`/admin/imports/${kind}/template?format=csv`, `${kind}-template.csv`)}><Download className="size-4" /> CSV template</Button>
          <Button variant="secondary" size="sm" onClick={() => download(`/admin/imports/${kind}/template?format=xlsx`, `${kind}-template.xlsx`)}><Download className="size-4" /> Excel template</Button>
        </div>
        {kind === 'products' ? (
          <Select label="If a SKU already exists" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="create_only">Skip it and report an error (safe)</option>
            <option value="update_existing">Update its catalogue details (never changes stock)</option>
          </Select>
        ) : (
          <Select label="Import type" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="adjustment">Stock-take: set counted physical stock</option>
            <option value="opening">Opening stock: only for products with no stock history</option>
          </Select>
        )}
        <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-brand-200 bg-brand-50/50 p-4 text-center text-sm text-brand-800">
          <FileSpreadsheet className="size-7" />
          <span className="font-semibold">Choose a .csv or .xlsx file</span>
          <span className="text-xs text-muted">{kind === 'products' ? 'Catalogue only: stock quantities are never read from this file' : 'Columns: sku, quantity (counted stock)'}</span>
          <input ref={fileRef} type="file" accept=".csv,.xlsx" className="sr-only" onChange={(e) => e.target.files?.[0] && parseFile(e.target.files[0])} />
        </label>
      </Card>

      {result && <Card className="border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900">{kind === 'products' ? `Done: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.` : `Done: ${result.rows} rows processed, ${result.changed} changed.`}</Card>}

      {rows && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-4">
            <div><h2 className="font-bold text-brand-900">Preview</h2><p className="text-sm text-muted">{rows.length} rows · {rows.length - bad} valid · <span className={bad ? 'font-semibold text-accent-600' : ''}>{bad} with errors</span>. Edit cells to fix, then re-check.</p></div>
            <div className="flex gap-2">
              {bad > 0 && <Button size="sm" variant="secondary" onClick={() => errorCsv(rows, validated, cols)}><Download className="size-4" /> Error report</Button>}
              <Button size="sm" variant="secondary" loading={busy} onClick={() => revalidate()}>Re-check</Button>
            </div>
          </div>
          <Table>
            <thead><tr><Th>#</Th>{cols.map((c) => <Th key={c}>{c}</Th>)}{kind === 'stock' && <><Th>current</Th><Th>change</Th></>}<Th>Result</Th></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const v = validated[i];
                return (
                  <tr key={i} className={cx(v?.errors.length ? 'bg-rose-50' : '')}>
                    <Td className="text-muted">{i + 2}</Td>
                    {cols.map((c) => (
                      <Td key={c} className="p-1"><input aria-label={`${c} row ${i + 2}`} value={r[c] ?? ''} onChange={(e) => { const next = rows.map((x, j) => (j === i ? { ...x, [c]: e.target.value } : x)); setRows(next); }} className="h-9 w-full min-w-24 rounded-lg border border-transparent bg-transparent px-2 text-sm hover:border-line focus:border-brand-500 focus:bg-white" /></Td>
                    ))}
                    {kind === 'stock' && <><Td>{v?.currentStock ?? '—'}</Td><Td>{v?.delta === undefined ? '—' : v.delta > 0 ? `+${v.delta}` : v.delta}</Td></>}
                    <Td className="min-w-48 text-xs">{v?.errors.length ? <span className="text-accent-600">{v.errors.join('; ')}</span> : <Pill tone="green">{v?.action === 'update' ? 'Will update' : kind === 'products' ? 'Will create' : 'OK'}</Pill>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <div className="space-y-3 border-t border-line p-4">
            {kind === 'stock' && (<>
              <Input label="Reason (required, saved in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-5" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I confirm these quantities replace the current physical stock. This is all-or-nothing and cannot be undone except by another adjustment.</label>
            </>)}
            <Button size="lg" loading={busy} disabled={rows.length === bad || (kind === 'stock' && (bad > 0 || !confirm || reason.trim().length < 3))} onClick={commit}>
              {kind === 'products' ? `Import ${rows.length - bad} valid row${rows.length - bad === 1 ? '' : 's'}${bad ? ` (skip ${bad})` : ''}` : `Apply stock for ${rows.length} products`}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

export default function ImportPage() {
  const [kind, setKind] = useState<Kind>('products');
  return (
    <div>
      <PageHeader title="Import" subtitle="Bring in your real product list and stock counts" />
      <div className="mb-4 flex gap-2">
        <Button variant={kind === 'products' ? 'primary' : 'secondary'} onClick={() => setKind('products')}>Product catalogue</Button>
        <Button variant={kind === 'stock' ? 'primary' : 'secondary'} onClick={() => setKind('stock')}>Stock quantities</Button>
      </div>
      <Importer key={kind} kind={kind} />
    </div>
  );
}
