import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList } from 'lucide-react';
import { get, qs } from '../../api';
import { DELIVERY_LABEL, fmtDate, money, STATUS_LABEL } from '../../format';
import { Button, Card, Empty, ErrorBox, filterCls, PageHeader, Pill, Spinner, StatusBadge, Table, Td, Th } from '../../ui';

export default function AdminOrders() {
  const [params, setParams] = useSearchParams();
  const f = Object.fromEntries(params.entries());
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); n.delete('offset'); setParams(n, { replace: true }); };
  const offset = Number(f.offset) || 0;
  const retailers = useQuery({ queryKey: ['retailers'], queryFn: () => get('/admin/retailers') });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['orders', 'admin', f],
    queryFn: () => get(`/orders${qs({ from: f.from, to: f.to, retailerId: f.retailerId, status: f.status, deliveryStatus: f.deliveryStatus, q: f.q, limit: 25, offset })}`),
    placeholderData: (p) => p,
  });

  return (
    <div>
      <PageHeader title="Orders" subtitle="All retailer orders" />
      <Card className="mb-4 grid grid-cols-2 gap-3 p-3 lg:grid-cols-6">
        <input aria-label="Search order or retailer" placeholder="Search…" value={f.q ?? ''} onChange={(e) => set('q', e.target.value)} className={`${filterCls} col-span-2 lg:col-span-1`} />
        <label className="text-xs text-muted">Ordered from<input type="date" value={f.from ?? ''} onChange={(e) => set('from', e.target.value)} className={`${filterCls} mt-1 w-full`} /></label>
        <label className="text-xs text-muted">Ordered to<input type="date" value={f.to ?? ''} onChange={(e) => set('to', e.target.value)} className={`${filterCls} mt-1 w-full`} /></label>
        <select aria-label="Retailer" value={f.retailerId ?? ''} onChange={(e) => set('retailerId', e.target.value)} className={`${filterCls} self-end`}>
          <option value="">All retailers</option>
          {retailers.data?.retailers.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select aria-label="Order status" value={f.status ?? ''} onChange={(e) => set('status', e.target.value)} className={`${filterCls} self-end`}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select aria-label="Delivery status" value={f.deliveryStatus ?? ''} onChange={(e) => set('deliveryStatus', e.target.value)} className={`${filterCls} self-end`}>
          <option value="">Any delivery status</option>
          <option value="PENDING">Pending</option><option value="DELIVERED">Delivered</option><option value="PARTIAL">Partial</option><option value="NONE">Cancelled/Rejected</option>
        </select>
      </Card>

      <Card>
        {isLoading ? <Spinner /> : error ? <div className="p-4"><ErrorBox error={error} retry={refetch} /></div> : data.orders.length === 0 ? (
          <Empty icon={<ClipboardList className="size-12" />} title="No orders match these filters" />
        ) : (
          <>
            <Table>
              <thead><tr><Th>Order</Th><Th>Retailer</Th><Th>Ordered</Th><Th>Delivery</Th><Th className="text-right">Items</Th><Th>Status</Th><Th>Delivery status</Th><Th>{''}</Th></tr></thead>
              <tbody>
                {data.orders.map((o: any) => (
                  <tr key={o.id} className="hover:bg-slate-50">
                    <Td className="font-semibold"><Link to={`/admin/orders/${o.id}`} className="text-brand-700">{o.order_number}</Link></Td>
                    <Td>{o.retailer_name}</Td>
                    <Td>{fmtDate(o.created_at)}</Td>
                    <Td>{fmtDate(o.delivery_date)}</Td>
                    <Td className="text-right">{o.item_count}</Td>
                    <Td><StatusBadge status={o.status} /></Td>
                    <Td><Pill tone={o.delivery_status === 'DELIVERED' ? 'green' : o.delivery_status === 'PARTIAL' ? 'amber' : 'slate'}>{DELIVERY_LABEL[o.delivery_status]}</Pill></Td>
                    <Td className="text-right"><Link to={`/admin/orders/${o.id}`}><Button size="sm" variant="secondary">Open</Button></Link></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between p-3 text-sm text-muted">
              <span>{offset + 1}–{offset + data.orders.length} of {data.total}{data.orders[0] ? '' : ''} · total {money(data.orders.reduce((s: number, o: any) => s + (o.total_amount ?? 0), 0))} on this page</span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => set('offset', String(Math.max(0, offset - 25)))}>Previous</Button>
                <Button size="sm" variant="secondary" disabled={offset + 25 >= data.total} onClick={() => { const n = new URLSearchParams(params); n.set('offset', String(offset + 25)); setParams(n, { replace: true }); }}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
