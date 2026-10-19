import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCheck, ClipboardList, PackageCheck, Store, Truck } from 'lucide-react';
import { get } from '../../api';
import { fmtDate } from '../../format';
import { Card, ErrorBox, PageHeader, Spinner, StatusBadge } from '../../ui';

export default function Dashboard() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['dashboard', 'admin'], queryFn: () => get('/dashboard/admin'), refetchInterval: 30000 });
  const orders = useQuery({ queryKey: ['orders', 'recent'], queryFn: () => get('/orders?limit=8') });
  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} retry={refetch} />;
  const c = data.cards;
  const cards = [
    { label: 'Active retailers', value: c.active_retailers, icon: Store, to: '/admin/retailers', tone: 'text-brand-700 bg-brand-50' },
    { label: 'Orders today', value: c.orders_today, icon: ClipboardList, to: '/admin/orders', tone: 'text-sky-700 bg-sky-50' },
    { label: 'Awaiting processing', value: c.awaiting_processing, icon: PackageCheck, to: '/admin/orders?status=SUBMITTED', tone: 'text-amber-700 bg-amber-50' },
    { label: 'Awaiting delivery', value: c.awaiting_delivery, icon: Truck, to: '/admin/orders?deliveryStatus=PENDING', tone: 'text-violet-700 bg-violet-50' },
    { label: 'Delivered today', value: c.delivered_today, icon: CheckCheck, to: '/admin/orders?status=DELIVERED', tone: 'text-emerald-700 bg-emerald-50' },
    { label: 'Low-stock products', value: c.low_stock, icon: AlertTriangle, to: '/admin/inventory?low=1', tone: c.low_stock > 0 ? 'text-rose-700 bg-rose-50' : 'text-slate-600 bg-slate-100' },
  ];
  return (
    <div>
      <PageHeader title="Dashboard" subtitle={`Today is ${fmtDate(data.today)}`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {cards.map((k) => (
          <Link key={k.label} to={k.to}>
            <Card className="h-full p-4 transition-shadow hover:shadow-md">
              <div className={`mb-3 grid size-10 place-items-center rounded-xl ${k.tone}`}><k.icon className="size-5" /></div>
              <div className="text-3xl font-bold tabular-nums">{k.value}</div>
              <div className="text-sm text-muted">{k.label}</div>
            </Card>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between border-b border-line p-4"><h2 className="font-bold text-brand-900">Latest orders</h2><Link to="/admin/orders" className="text-sm font-semibold text-brand-700">View all</Link></div>
          {orders.isLoading ? <Spinner /> : orders.data.orders.length === 0 ? <p className="p-8 text-center text-sm text-muted">No orders yet.</p> : (
            <ul>
              {orders.data.orders.map((o: any) => (
                <li key={o.id} className="border-b border-line last:border-0">
                  <Link to={`/admin/orders/${o.id}`} className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 hover:bg-slate-50">
                    <div><div className="font-semibold">{o.order_number} · {o.retailer_name}</div><div className="text-sm text-muted">Delivery {fmtDate(o.delivery_date)} · {o.item_count} item{o.item_count === 1 ? "" : "s"}</div></div>
                    <StatusBadge status={o.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="mb-3 font-bold text-brand-900">Upcoming deliveries</h2>
          {data.upcoming.length === 0 ? <p className="py-6 text-center text-sm text-muted">Nothing scheduled.</p> : (
            <ul className="space-y-2">{data.upcoming.map((u: any) => (
              <li key={u.delivery_date} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm"><span className="font-medium">{fmtDate(u.delivery_date)}</span><span className="font-bold">{u.orders} order{u.orders > 1 ? 's' : ''}</span></li>
            ))}</ul>
          )}
        </Card>
      </div>
    </div>
  );
}
