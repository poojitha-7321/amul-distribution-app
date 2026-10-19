import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus } from 'lucide-react';
import { get } from '../../api';
import { useCart } from '../../cart';
import { fmtDate } from '../../format';
import { Button, Card, ErrorBox, Spinner, StatusBadge, useToast } from '../../ui';
import { useReorder } from '../OrderDetail';

export default function RetailerHome() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['retailer-dashboard'], queryFn: () => get('/dashboard/retailer') });
  const cart = useCart();
  const toast = useToast();
  const reorder = useReorder();
  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} retry={refetch} />;
  const last = data.recent[0];

  return (
    <div className="space-y-5">
      <Link to="/catalogue" className="flex min-h-16 items-center justify-between rounded-2xl bg-accent-500 px-5 text-lg font-bold text-white shadow-md">
        Place a new order <ArrowRight className="size-6" />
      </Link>

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-4"><div className="text-3xl font-bold text-brand-800">{data.counts.open_orders}</div><div className="text-sm text-muted">Orders in progress</div></Card>
        <Card className="p-4"><div className="text-3xl font-bold text-emerald-700">{data.counts.delivered_orders}</div><div className="text-sm text-muted">Delivered orders</div></Card>
      </div>

      {last && (
        <Card className="p-4">
          <div className="mb-1 text-sm font-semibold text-muted">Repeat your last order</div>
          <div className="flex items-center justify-between gap-3">
            <div><div className="font-bold text-brand-900">{last.order_number}</div><div className="text-sm text-muted">{last.item_count} item{last.item_count > 1 ? 's' : ''} · {fmtDate(last.created_at)}</div></div>
            <Button loading={reorder.isPending} onClick={() => reorder.mutate(last.id)}>Order again</Button>
          </div>
        </Card>
      )}

      {data.frequent.length > 0 && (
        <section>
          <h2 className="mb-2 font-bold text-brand-900">Frequently ordered</h2>
          <div className="space-y-2">
            {data.frequent.map((f: any) => (
              <Card key={f.variant_id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{f.product_name}</div>
                  <div className="text-sm text-muted">{f.pack_size} {f.pack_size_unit} · ordered {f.times_ordered}×</div>
                </div>
                <Button size="sm" variant="secondary" aria-label={`Add ${f.product_name} to cart`} onClick={() => { cart.setQty(f.variant_id, f.stock_unit, cart.qtyOf(f.variant_id, f.stock_unit) + 1); toast.success(`${f.product_name} added`); }}>
                  <Plus className="size-4" /> Add
                </Button>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between"><h2 className="font-bold text-brand-900">Recent orders</h2><Link to="/orders" className="text-sm font-semibold text-brand-700">View all</Link></div>
        {data.recent.length === 0 ? <Card className="p-6 text-center text-sm text-muted">No orders yet. Tap “Place a new order” to start.</Card> : (
          <div className="space-y-2">
            {data.recent.map((o: any) => (
              <Link key={o.id} to={`/orders/${o.id}`}>
                <Card className="mb-2 flex items-center justify-between gap-2 p-3">
                  <div><div className="font-semibold">{o.order_number}</div><div className="text-sm text-muted">Delivery {fmtDate(o.delivery_date)}</div></div>
                  <StatusBadge status={o.status} />
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
      <div className="text-center"><Link to="/account/password" className="text-sm text-muted underline">Change password</Link></div>
    </div>
  );
}
