import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList } from 'lucide-react';
import { get, qs } from '../../api';
import { fmtDate, money } from '../../format';
import { Button, Card, Empty, ErrorBox, Spinner, StatusBadge, cx } from '../../ui';
import { useReorder } from '../OrderDetail';

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'PENDING', label: 'In progress' },
  { key: 'DELIVERED', label: 'Delivered' },
  { key: 'NONE', label: 'Cancelled' },
];

export default function MyOrders() {
  const [f, setF] = useState('');
  const reorder = useReorder();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['orders', 'mine', f], queryFn: () => get(`/orders${qs({ deliveryStatus: f, limit: 100 })}`) });

  return (
    <div>
      <h1 className="mb-3 text-xl font-bold text-brand-900">My orders</h1>
      <div className="mb-4 flex gap-2 overflow-x-auto" role="tablist">
        {FILTERS.map((x) => (
          <button key={x.key} role="tab" aria-selected={f === x.key} onClick={() => setF(x.key)} className={cx('min-h-10 shrink-0 rounded-full border px-4 text-sm font-semibold', f === x.key ? 'border-brand-700 bg-brand-700 text-white' : 'border-line bg-white')}>{x.label}</button>
        ))}
      </div>
      {isLoading ? <Spinner /> : error ? <ErrorBox error={error} retry={refetch} /> : data.orders.length === 0 ? (
        <Card><Empty icon={<ClipboardList className="size-12" />} title="No orders yet" hint="Your orders will appear here with live status." action={<Link to="/catalogue"><Button>Place your first order</Button></Link>} /></Card>
      ) : (
        <div className="space-y-3">
          {data.orders.map((o: any) => (
            <Card key={o.id} className="p-4">
              <Link to={`/orders/${o.id}`} className="block">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-bold text-brand-900">{o.order_number}</div>
                    <div className="text-sm text-muted">Delivery {fmtDate(o.delivery_date)} · {o.item_count} item{o.item_count > 1 ? 's' : ''}</div>
                  </div>
                  <StatusBadge status={o.status} />
                </div>
                <div className="mt-2 text-sm font-semibold">{o.delivered_amount !== null ? money(o.delivered_amount) : money(o.total_amount)}</div>
              </Link>
              <div className="mt-3 border-t border-line pt-3">
                <Button size="sm" variant="secondary" loading={reorder.isPending} onClick={() => reorder.mutate(o.id)}>Order again</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
