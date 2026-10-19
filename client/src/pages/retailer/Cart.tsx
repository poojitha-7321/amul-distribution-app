import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShoppingCart, Trash2 } from 'lucide-react';
import { ApiError, get, post } from '../../api';
import { useCart } from '../../cart';
import { money } from '../../format';
import { Button, Card, Empty, ErrorBox, Input, Spinner, Stepper, Textarea, useToast } from '../../ui';
import { useCatalog } from './Catalogue';

export default function Cart() {
  const cart = useCart();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useCatalog();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') });
  const [date, setDate] = useState('');
  const [notes, setNotes] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!date && settings.data?.minDeliveryDate) setDate(settings.data.minDeliveryDate);
  }, [settings.data, date]);

  const rows = useMemo(() => {
    const variants = new Map<number, { p: any; v: any }>();
    for (const p of data?.products ?? []) for (const v of p.variants) variants.set(v.id, { p, v });
    return cart.lines.map((l) => {
      const found = variants.get(l.variantId);
      const price = found ? (l.unit === 'crate' ? found.v.cratePrice : found.v.price) : null;
      return { line: l, ...found, price, subtotal: price === null ? null : price * l.quantity, gone: !found };
    });
  }, [cart.lines, data]);

  const priced = rows.length > 0 && rows.every((r) => r.subtotal !== null && !r.gone);
  const total = priced ? rows.reduce((s, r) => s + (r.subtotal ?? 0), 0) : null;
  const hasGone = rows.some((r) => r.gone);

  const submit = useMutation({
    mutationFn: () => post('/orders', { deliveryDate: date, notes: notes || undefined, submitToken: cart.submitToken, items: cart.lines.map((l) => ({ variantId: l.variantId, unit: l.unit, quantity: l.quantity })) }),
    onSuccess: (res) => {
      cart.clear();
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['retailer-dashboard'] });
      nav(`/orders/${res.id}?placed=1`, { replace: true });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) setProblem(e.message);
      else toast.error(e);
      void refetch();
    },
  });

  if (isLoading || settings.isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} retry={refetch} />;
  if (cart.count === 0) {
    return (
      <Card><Empty icon={<ShoppingCart className="size-12" />} title="Your cart is empty" hint="Pick milk and curd products to build your order for tomorrow."
        action={<Link to="/catalogue"><Button>Browse products</Button></Link>} /></Card>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-brand-900">Review your order</h1>
      {problem && <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="alert">{problem}</div>}
      {hasGone && <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="alert">Some products are no longer available. Remove them to continue.</div>}

      <Card className="divide-y divide-line">
        {rows.map((r) => (
          <div key={`${r.line.variantId}-${r.line.unit}`} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-brand-900">{r.gone ? 'Unavailable product' : `${r.p.name} · ${r.v.packSize} ${r.v.packSizeUnit}`}</div>
                {!r.gone && <div className="text-sm text-muted">{r.v.name} · {r.line.unit === 'crate' ? `Crate of ${r.v.unitsPerCrate}` : r.line.unit}{r.v.stockStatus === 'out' ? ' · currently out of stock' : ''}</div>}
              </div>
              <button onClick={() => cart.setQty(r.line.variantId, r.line.unit, 0)} aria-label="Remove item" className="grid size-10 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="size-5" /></button>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <Stepper label="Quantity" value={r.line.quantity} min={0} onChange={(n) => cart.setQty(r.line.variantId, r.line.unit, n)} />
              <div className="text-right">
                <div className="text-xs text-muted">{r.price === null ? '' : `${money(r.price)} each`}</div>
                <div className="font-bold">{r.subtotal === null ? '—' : money(r.subtotal)}</div>
              </div>
            </div>
          </div>
        ))}
      </Card>

      <Card className="space-y-4 p-4">
        <Input label="Delivery date" type="date" required value={date} min={settings.data?.minDeliveryDate} max={settings.data?.maxDeliveryDate} onChange={(e) => setDate(e.target.value)} hint="Orders are delivered from the next day onwards" />
        <Textarea label="Notes for the distributor (optional)" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between text-lg">
          <span className="font-semibold">Estimated total</span>
          <span className="font-bold text-brand-900">{total === null ? 'Prices confirmed on delivery' : money(total)}</span>
        </div>
        <p className="mt-1 text-xs text-muted">Final amount is calculated by the distributor based on what is delivered.</p>
      </Card>

      <Button size="lg" full loading={submit.isPending} disabled={hasGone || !date || submit.isPending} onClick={() => { setProblem(null); submit.mutate(); }}>
        Place order
      </Button>
    </div>
  );
}
