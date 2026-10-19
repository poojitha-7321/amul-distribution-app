import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Search, ShoppingCart } from 'lucide-react';
import { get } from '../../api';
import { useCart } from '../../cart';
import { money } from '../../format';
import { Button, Card, Empty, ErrorBox, Pill, Spinner, Stepper, cx, useToast } from '../../ui';

export interface CatalogVariant {
  id: number; name: string; sku: string; packSize: number; packSizeUnit: string; stockUnit: string;
  unitsPerCrate: number | null; defaultOrderUnit: string; price: number | null; cratePrice: number | null;
  available: number; stockStatus: 'in' | 'low' | 'out';
}
export interface CatalogProduct { id: number; name: string; brand: string; description: string | null; imageUrl: string | null; categoryId: number; variants: CatalogVariant[] }

export const useCatalog = () => useQuery({ queryKey: ['catalog'], queryFn: () => get<{ categories: { id: number; name: string }[]; products: CatalogProduct[] }>('/catalog') });

const EMOJI: Record<string, string> = { Milk: '🥛', 'Curd / Dahi': '🍶' };

function ProductCard({ p, catName }: { p: CatalogProduct; catName: string }) {
  const cart = useCart();
  const toast = useToast();
  const initial = p.variants.find((v) => v.stockStatus !== 'out') ?? p.variants[0];
  const [vid, setVid] = useState(initial.id);
  const v = p.variants.find((x) => x.id === vid) ?? initial;
  const [unit, setUnit] = useState(v.defaultOrderUnit);
  const [qty, setQty] = useState(1);

  const crate = v.unitsPerCrate;
  const activeUnit = unit === 'crate' && !crate ? v.stockUnit : unit;
  const unitPrice = activeUnit === 'crate' ? v.cratePrice : v.price;
  const inCart = cart.qtyOf(v.id, activeUnit);
  const out = v.stockStatus === 'out';

  const pickVariant = (id: number) => {
    const nv = p.variants.find((x) => x.id === id)!;
    setVid(id);
    setUnit(nv.defaultOrderUnit);
    setQty(1);
  };

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex gap-3 p-4">
        {p.imageUrl ? (
          <img src={p.imageUrl} alt="" loading="lazy" className="size-20 shrink-0 rounded-xl bg-slate-50 object-cover" />
        ) : (
          <div className="grid size-20 shrink-0 place-items-center rounded-xl bg-brand-50 text-4xl" aria-hidden>{EMOJI[catName] ?? '🥛'}</div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="font-bold leading-tight text-brand-900">{p.name}</h3>
          <p className="text-sm text-muted">{p.brand} · {catName}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="text-lg font-bold text-ink">{unitPrice === null ? 'Price on request' : money(unitPrice)}</span>
            <span className="text-xs text-muted">/ {activeUnit === 'crate' ? `crate of ${crate}` : v.stockUnit}</span>
            {v.stockStatus === 'low' && <Pill tone="amber">Low stock</Pill>}
            {out && <Pill tone="red">Out of stock</Pill>}
          </div>
        </div>
      </div>

      {p.variants.length > 1 && (
        <div className="flex flex-wrap gap-2 px-4 pb-3" role="radiogroup" aria-label={`${p.name} pack size`}>
          {p.variants.map((x) => (
            <button key={x.id} role="radio" aria-checked={x.id === v.id} onClick={() => pickVariant(x.id)} className={cx('min-h-10 rounded-full border px-3 text-sm font-medium', x.id === v.id ? 'border-brand-700 bg-brand-700 text-white' : 'border-line bg-white text-slate-700', x.stockStatus === 'out' && 'opacity-50')}>
              {x.packSize} {x.packSizeUnit}
            </button>
          ))}
        </div>
      )}
      {p.variants.length === 1 && <p className="px-4 pb-3 text-sm text-slate-600">{v.name}</p>}

      {crate && (
        <div className="flex gap-2 px-4 pb-3" role="radiogroup" aria-label="Order unit">
          {[v.stockUnit, 'crate'].map((u) => (
            <button key={u} role="radio" aria-checked={activeUnit === u} onClick={() => setUnit(u)} className={cx('min-h-10 flex-1 rounded-xl border px-3 text-sm font-medium', activeUnit === u ? 'border-brand-700 bg-brand-50 text-brand-800' : 'border-line text-slate-600')}>
              {u === 'crate' ? `Crate (${crate})` : `Single ${u}`}
            </button>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-line bg-slate-50/60 p-3">
        <Stepper label={`${p.name} ${v.name} quantity`} value={qty} min={1} onChange={setQty} />
        <Button
          disabled={out}
          onClick={() => {
            cart.setQty(v.id, activeUnit, inCart + qty);
            toast.success(`Added ${qty} × ${p.name} ${v.packSize} ${v.packSizeUnit}`);
            setQty(1);
          }}
          className="flex-1"
        >
          {inCart > 0 ? <><Check className="size-4" /> Add more ({inCart})</> : 'Add'}
        </Button>
      </div>
    </Card>
  );
}

export default function Catalogue() {
  const { data, isLoading, error, refetch } = useCatalog();
  const cart = useCart();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const cat = Number(params.get('category')) || 0;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.products ?? []).filter((p) => (!cat || p.categoryId === cat) && (!q || `${p.name} ${p.variants.map((v) => v.name).join(' ')}`.toLowerCase().includes(q)));
  }, [data, search, cat]);

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} retry={refetch} />;
  const catName = (id: number) => data!.categories.find((c) => c.id === id)?.name ?? '';

  return (
    <div>
      <h1 className="mb-3 text-xl font-bold text-brand-900">Order products</h1>
      <div className="sticky top-[52px] z-10 -mx-4 space-y-3 bg-surface/95 px-4 pb-3 pt-1 backdrop-blur sm:top-[92px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input type="search" aria-label="Search products" placeholder="Search milk, dahi…" value={search} onChange={(e) => setSearch(e.target.value)} className="min-h-12 w-full rounded-2xl border border-line bg-white pl-10 pr-3" />
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Categories">
          {[{ id: 0, name: 'All' }, ...(data?.categories ?? [])].map((c) => (
            <button key={c.id} role="tab" aria-selected={cat === c.id} onClick={() => setParams(c.id ? { category: String(c.id) } : {})} className={cx('min-h-10 shrink-0 rounded-full border px-4 text-sm font-semibold', cat === c.id ? 'border-brand-700 bg-brand-700 text-white' : 'border-line bg-white text-slate-700')}>
              {c.name}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <Card><Empty icon={<Search className="size-10" />} title="No products found" hint={search ? 'Try a different spelling or clear the search.' : 'No products are available right now. Please contact your distributor.'} /></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {shown.map((p) => <ProductCard key={p.id} p={p} catName={catName(p.categoryId)} />)}
        </div>
      )}

      {cart.count > 0 && (
        <div className="safe-bottom fixed inset-x-0 bottom-16 z-10 mx-auto max-w-3xl px-4 sm:bottom-4 lg:max-w-5xl">
          <Link to="/cart" className="flex min-h-14 items-center justify-between rounded-2xl bg-accent-500 px-5 font-semibold text-white shadow-xl">
            <span className="flex items-center gap-2"><ShoppingCart className="size-5" /> {cart.count} item{cart.count > 1 ? 's' : ''} in cart</span>
            <span>Review order →</span>
          </Link>
        </div>
      )}
    </div>
  );
}
