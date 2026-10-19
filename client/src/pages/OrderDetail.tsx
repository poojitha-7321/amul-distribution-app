import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Circle } from 'lucide-react';
import { get, post } from '../api';
import { useCart } from '../cart';
import { fmtDate, fmtDateTime, money, STATUS_LABEL } from '../format';
import { Button, Card, ConfirmButton, ErrorBox, Input, Modal, Spinner, StatusBadge, Table, Td, Textarea, Th, useToast } from '../ui';

/** "Order again": rebuilds the cart from a previous order and opens it. */
export function useReorder() {
  const cart = useCart();
  const nav = useNavigate();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: number) => get(`/orders/${id}/reorder`),
    onSuccess: (r: any) => {
      if (r.lines.length === 0) return toast.error('None of those products are available any more');
      cart.replace(r.lines);
      cart.resetToken();
      if (r.skipped.length) toast.error(`Not available now: ${r.skipped.join(', ')}`);
      nav('/cart');
    },
    onError: toast.error,
  });
}

const unitText = (unit: string, qty: number) => (unit === 'crate' ? `crate${qty === 1 ? '' : 's'}` : unit);

export default function OrderDetail({ admin }: { admin?: boolean }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const reorder = useReorder();
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState('');
  const [qtys, setQtys] = useState<Record<number, number>>({});

  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['order', id], queryFn: () => get(`/orders/${id}`), refetchInterval: 20000 });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['order', id] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['inventory'] });
  };
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: object }) => post(`/orders/${id}/${action}`, body ?? {}),
    onSuccess: (res: any, v) => {
      refresh();
      setRejectOpen(false);
      setNote('');
      toast.success(v.action === 'accept' && res.shortages?.length ? 'Accepted with partial stock reserved' : 'Order updated');
    },
    onError: (e) => { toast.error(e); refresh(); },
  });
  const deliver = useMutation({
    mutationFn: () => post(`/orders/${id}/deliver`, { note: note || undefined, items: data.items.map((i: any) => ({ orderItemId: i.id, deliveredQuantity: qtys[i.id] ?? i.quantity })) }),
    onSuccess: () => { refresh(); setDeliverOpen(false); setNote(''); toast.success('Delivery confirmed and stock updated'); },
    onError: (e) => { toast.error(e); refresh(); },
  });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} retry={refetch} />;
  const { order, items, history, delivery, stock } = data;
  const status: string = order.status;
  const stockOf = (variantId: number) => stock?.find((s: any) => s.variant_id === variantId);
  const delivered = status === 'DELIVERED' || status === 'PARTIALLY_DELIVERED';
  const backTo = admin ? '/admin/orders' : '/orders';
  const retailerCanCancel = !admin && ['SUBMITTED', 'ACCEPTED'].includes(status);

  const flow = ['SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY_FOR_DELIVERY', status === 'PARTIALLY_DELIVERED' ? 'PARTIALLY_DELIVERED' : 'DELIVERED'];
  const closed = status === 'CANCELLED' || status === 'REJECTED';
  const reached = new Set(history.map((h: any) => h.to_status));

  return (
    <div className="space-y-4">
      <Link to={backTo} className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-brand-700"><ArrowLeft className="size-4" /> Orders</Link>

      {params.get('placed') && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-emerald-900" role="status">
          <div className="flex items-center gap-2 font-bold"><CheckCircle2 className="size-5" /> Order placed!</div>
          <p className="mt-1 text-sm">Your order number is <strong>{order.order_number}</strong>. You can follow its status on this page.</p>
        </div>
      )}

      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-brand-900">{order.order_number}</h1>
            <p className="text-sm text-muted">Placed {fmtDateTime(order.created_at)}{admin ? ` by ${order.placed_by_name}` : ''}</p>
          </div>
          <StatusBadge status={status} />
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          {admin && <div><dt className="text-muted">Retailer</dt><dd className="font-semibold">{order.retailer_name}</dd>{order.retailer_phone && <dd className="text-muted">{order.retailer_phone}</dd>}</div>}
          <div><dt className="text-muted">Delivery date</dt><dd className="font-semibold">{fmtDate(order.delivery_date)}</dd></div>
          <div><dt className="text-muted">{delivered ? 'Delivered value' : 'Order value'}</dt><dd className="font-semibold">{money(delivered ? order.delivered_amount : order.total_amount)}</dd></div>
          {order.notes && <div className="sm:col-span-3"><dt className="text-muted">Notes</dt><dd>{order.notes}</dd></div>}
        </dl>
      </Card>

      {!closed && (
        <Card className="p-3 sm:p-4">
          <ol className="grid grid-cols-5 gap-1" aria-label="Order progress">
            {flow.map((s, i) => {
              const done = reached.has(s);
              return (
                <li key={s} className="flex flex-col items-center gap-1 text-center text-[11px] leading-tight sm:text-xs">
                  <span className={done ? 'text-emerald-600' : 'text-slate-300'}>{done ? <CheckCircle2 className="size-5 sm:size-6" /> : <Circle className="size-5 sm:size-6" />}</span>
                  <span className={done ? 'font-semibold text-ink' : 'text-muted'}>{STATUS_LABEL[s]}</span>
                  {i < flow.length - 1 && <span className="sr-only">then</span>}
                </li>
              );
            })}
          </ol>
        </Card>
      )}

      <Card className="divide-y divide-line sm:hidden">
        {items.map((i: any) => {
          const short = delivered && i.delivered_quantity < i.quantity;
          const s = stockOf(i.variant_id);
          return (
            <div key={i.id} className="p-4">
              <div className="font-semibold">{i.product_name} <span className="font-normal text-muted">{i.pack_label}</span></div>
              <div className="text-xs text-muted">{i.variant_name}</div>
              <div className="mt-2 flex items-end justify-between text-sm">
                <div>
                  <div>Ordered: <strong>{i.quantity} {unitText(i.order_unit, i.quantity)}</strong>{i.order_unit === 'crate' && <span className="text-muted"> ({i.base_quantity} {i.stock_unit})</span>}</div>
                  {delivered && <div className={short ? 'font-bold text-accent-600' : ''}>Delivered: <strong>{i.delivered_quantity} {unitText(i.order_unit, i.delivered_quantity)}</strong>{short && ` (short by ${i.quantity - i.delivered_quantity})`}</div>}
                  {admin && !delivered && !closed && s && <div className="text-xs text-muted">Available {s.available_stock} of {s.physical_stock}{i.reserved_base_qty > 0 ? ` · ${i.reserved_base_qty} reserved` : ''}</div>}
                </div>
                <div className="text-right font-bold">{money(delivered && i.unit_price !== null ? i.unit_price * i.delivered_quantity : i.line_total)}</div>
              </div>
            </div>
          );
        })}
      </Card>
      <Card className="hidden sm:block">
        <Table>
          <thead><tr><Th>Product</Th><Th className="text-right">Ordered</Th>{delivered && <Th className="text-right">Delivered</Th>}<Th className="text-right">Price</Th><Th className="text-right">Total</Th>{admin && !delivered && !closed && <Th className="text-right">Stock (avail.)</Th>}</tr></thead>
          <tbody>
            {items.map((i: any) => {
              const s = stockOf(i.variant_id);
              const short = delivered && i.delivered_quantity < i.quantity;
              return (
                <tr key={i.id}>
                  <Td><div className="font-semibold">{i.product_name}</div><div className="text-xs text-muted">{i.variant_name} · {i.sku}</div></Td>
                  <Td className="text-right tabular-nums">{i.quantity} {unitText(i.order_unit, i.quantity)}{i.order_unit === 'crate' && <div className="text-xs text-muted">= {i.base_quantity} {i.stock_unit}</div>}</Td>
                  {delivered && <Td className={`text-right tabular-nums ${short ? 'font-bold text-accent-600' : ''}`}>{i.delivered_quantity} {unitText(i.order_unit, i.delivered_quantity)}{short && <div className="text-xs">short by {i.quantity - i.delivered_quantity}</div>}</Td>}
                  <Td className="text-right tabular-nums">{money(i.unit_price)}</Td>
                  <Td className="text-right font-semibold tabular-nums">{money(delivered && i.unit_price !== null ? i.unit_price * i.delivered_quantity : i.line_total)}</Td>
                  {admin && !delivered && !closed && <Td className="text-right tabular-nums">{s ? `${s.available_stock} / ${s.physical_stock}` : '—'}{i.reserved_base_qty > 0 && <div className="text-xs text-emerald-700">{i.reserved_base_qty} reserved</div>}</Td>}
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      {delivery && <Card className="p-4 text-sm">Delivery confirmed {fmtDateTime(delivery.delivered_at)} by {delivery.confirmed_by_name}.{delivery.note && <> Note: {delivery.note}</>}</Card>}

      <Card className="p-4">
        <h2 className="mb-3 font-bold text-brand-900">History</h2>
        <ul className="space-y-3">
          {[...history].reverse().map((h: any) => (
            <li key={h.id} className="flex gap-3 text-sm">
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-500" />
              <div><div className="font-semibold">{STATUS_LABEL[h.to_status]}</div><div className="text-muted">{fmtDateTime(h.created_at)}{h.user_name ? ` · ${h.user_name}` : ''}{h.note ? ` · “${h.note}”` : ''}</div></div>
            </li>
          ))}
        </ul>
      </Card>

      {/* Actions */}
      <div className="safe-bottom flex flex-wrap gap-2">
        {admin && status === 'SUBMITTED' && (<>
          <Button variant="success" loading={act.isPending} onClick={() => act.mutate({ action: 'accept' })}>Accept &amp; reserve stock</Button>
          <Button variant="danger" onClick={() => setRejectOpen(true)}>Reject</Button>
        </>)}
        {admin && status === 'ACCEPTED' && <Button loading={act.isPending} onClick={() => act.mutate({ action: 'prepare' })}>Start preparing</Button>}
        {admin && status === 'PREPARING' && <Button loading={act.isPending} onClick={() => act.mutate({ action: 'ready' })}>Mark ready for delivery</Button>}
        {admin && status === 'READY_FOR_DELIVERY' && <Button variant="success" onClick={() => { setQtys({}); setDeliverOpen(true); }}>Confirm delivery</Button>}
        {admin && ['ACCEPTED', 'PREPARING', 'READY_FOR_DELIVERY'].includes(status) && (
          <ConfirmButton variant="danger" message="Cancel this order? Reserved stock will be released." onConfirm={() => act.mutate({ action: 'cancel' })}>Cancel order</ConfirmButton>
        )}
        {retailerCanCancel && <ConfirmButton variant="danger" message="Cancel this order?" onConfirm={() => act.mutate({ action: 'cancel' })}>Cancel order</ConfirmButton>}
        {!admin && <Button variant="secondary" loading={reorder.isPending} onClick={() => reorder.mutate(order.id)}>Order again</Button>}
      </div>

      <Modal open={rejectOpen} onClose={() => setRejectOpen(false)} title="Reject order">
        <Textarea label="Reason (shown to the retailer)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setRejectOpen(false)}>Back</Button><Button variant="danger" loading={act.isPending} onClick={() => act.mutate({ action: 'reject', body: { note } })}>Reject order</Button></div>
      </Modal>

      <Modal open={deliverOpen} onClose={() => setDeliverOpen(false)} title="Confirm delivery" wide>
        <p className="mb-3 text-sm text-muted">Enter the quantity actually delivered. Stock is reduced by the delivered amount only; any shortfall is released back to available stock.</p>
        <div className="space-y-2">
          {items.map((i: any) => (
            <div key={i.id} className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
              <div className="min-w-0"><div className="font-semibold">{i.product_name} <span className="font-normal text-muted">{i.pack_label}</span></div><div className="text-xs text-muted">Ordered {i.quantity} {unitText(i.order_unit, i.quantity)}</div></div>
              <input type="number" inputMode="numeric" min={0} max={i.quantity} aria-label={`Delivered quantity for ${i.product_name}`} value={qtys[i.id] ?? i.quantity} onChange={(e) => setQtys({ ...qtys, [i.id]: Math.max(0, Math.min(i.quantity, Math.floor(Number(e.target.value) || 0))) })} className="h-11 w-24 rounded-xl border border-line text-center font-semibold" />
            </div>
          ))}
        </div>
        <div className="mt-3"><Input label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></div>
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setDeliverOpen(false)}>Back</Button><Button variant="success" loading={deliver.isPending} onClick={() => deliver.mutate()}>Confirm &amp; update stock</Button></div>
      </Modal>
    </div>
  );
}
