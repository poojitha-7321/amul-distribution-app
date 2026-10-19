import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { download, get, qs } from '../../api';
import { Button, Card, Empty, ErrorBox, filterCls, PageHeader, Spinner, Table, Td, Th, useToast } from '../../ui';
import { toLocalISO } from '../../format';

const NO_DATES = new Set(['current-stock', 'low-stock']);

export default function Reports() {
  const toast = useToast();
  const [name, setName] = useState('daily-orders');
  const today = new Date();
  const [from, setFrom] = useState(toLocalISO(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(toLocalISO(today));
  const [retailerId, setRetailerId] = useState('');
  const list = useQuery({ queryKey: ['reports'], queryFn: () => get('/admin/reports') });
  const retailers = useQuery({ queryKey: ['retailers'], queryFn: () => get('/admin/retailers') });
  const params = { from: NO_DATES.has(name) ? undefined : from, to: NO_DATES.has(name) ? undefined : to, retailerId: retailerId || undefined };
  const report = useQuery({ queryKey: ['report', name, params], queryFn: () => get(`/admin/reports/${name}${qs(params)}`) });

  const exportAs = async (format: 'csv' | 'xlsx') => {
    try { await download(`/admin/reports/${name}${qs({ ...params, format })}`, `${name}.${format}`); } catch (e) { toast.error(e); }
  };

  return (
    <div>
      <PageHeader title="Reports" subtitle="Filter, then export to CSV or Excel"
        actions={<><Button variant="secondary" onClick={() => exportAs('csv')}><Download className="size-4" /> CSV</Button><Button variant="secondary" onClick={() => exportAs('xlsx')}><Download className="size-4" /> Excel</Button></>} />
      <Card className="mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <select aria-label="Report" value={name} onChange={(e) => setName(e.target.value)} className={filterCls}>
          {list.data?.reports.map((r: any) => <option key={r.name} value={r.name}>{r.title}</option>)}
        </select>
        <input type="date" aria-label="From date" value={from} disabled={NO_DATES.has(name)} onChange={(e) => setFrom(e.target.value)} className={filterCls} />
        <input type="date" aria-label="To date" value={to} disabled={NO_DATES.has(name)} onChange={(e) => setTo(e.target.value)} className={filterCls} />
        <select aria-label="Retailer" value={retailerId} onChange={(e) => setRetailerId(e.target.value)} className={filterCls}>
          <option value="">All retailers</option>{retailers.data?.retailers.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Card>
      <Card>
        {report.isLoading ? <Spinner /> : report.error ? <div className="p-4"><ErrorBox error={report.error} retry={() => report.refetch()} /></div> : report.data.rows.length === 0 ? <Empty title="No data for these filters" /> : (
          <Table>
            <thead><tr>{report.data.columns.map((c: any) => <Th key={c.key}>{c.label}</Th>)}</tr></thead>
            <tbody>{report.data.rows.map((r: any, i: number) => <tr key={i}>{report.data.columns.map((c: any) => <Td key={c.key}>{r[c.key] ?? '—'}</Td>)}</tr>)}</tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
