import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes } from 'lucide-react';
import { get, post, qs } from '../../api';
import { fmtDateTime } from '../../format';
import { Button, Card, Empty, ErrorBox, filterCls, Input, Modal, PageHeader, Pill, Select, Spinner, Table, Td, Th, useToast } from '../../ui';

type Dialog = { kind: 'adjust' | 'return'; item: any } | null;

export default function Inventory() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const low = params.get('low') === '1';
  const [tab, setTab] = useState<'stock' | 'history'>('stock');
  const [dialog, setDialog] = useState<Dialog>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const [newStock, setNewStock] = useState('');
  const [reason, setReason] = useState('');
  const [kind, setKind] = useState('RETURN');
  const [qty, setQty] = useState('1');
  const [retailerId, setRetailerId] = useState('');

  const stock = useQuery({ queryKey: ['inventory', q, low], queryFn: () => get(`/admin/inventory${qs({ q, low: low ? '1' : undefined })}`) });
  const history = useQuery({ queryKey: ['inventory', 'tx'], queryFn: () => get('/admin/inventory/transactions?limit=100'), enabled: tab === 'history' });
  const retailers = useQuery({ queryKey: ['retailers'], queryFn: () => get('/admin/retailers'), enabled: dialog?.kind === 'return' });

  const done = () => { setDialog(null); setReason(''); void qc.invalidateQueries({ queryKey: ['inventory'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); };
  const adjust = useMutation({
    mutationFn: () => post(`/admin/inventory/${dialog!.item.variant_id}/adjust`, { newStock: Number(newStock), reason }),
    onSuccess: () => { toast.success('Stock corrected'); done(); }, onError: toast.error,
  });
  const ret = useMutation({
    mutationFn: () => post('/admin/inventory/returns', { variantId: dialog!.item.variant_id, kind, quantity: Number(qty), reason, retailerId: retailerId ? Number(retailerId) : undefined }),
    onSuccess: () => { toast.success('Recorded'); done(); }, onError: toast.error,
  });

  return (
    <div>
      <PageHeader title="Inventory" subtitle="Physical stock, reservations and what is available to promise" />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(['stock', 'history'] as const).map((t) => <Button key={t} size="sm" variant={tab === t ? 'primary' : 'secondary'} onClick={() => setTab(t)}>{t === 'stock' ? 'Current stock' : 'Movement history'}</Button>)}
        {tab === 'stock' && (<>
          <input aria-label="Search stock" placeholder="Search product or SKU" value={q} onChange={(e) => setQ(e.target.value)} className={`${filterCls} ml-auto w-56`} />
          <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={low} onChange={(e) => setParams(e.target.checked ? { low: '1' } : {}, { replace: true })} className="size-4" /> Low stock only</label>
        </>)}
      </div>

      {tab === 'stock' ? (
        <Card>
          {stock.isLoading ? <Spinner /> : stock.error ? <div className="p-4"><ErrorBox error={stock.error} retry={() => stock.refetch()} /></div> : stock.data.items.length === 0 ? <Empty icon={<Boxes className="size-12" />} title="Nothing to show" hint={low ? 'No products are below their minimum.' : 'Add products first.'} /> : (
            <Table>
              <thead><tr><Th>Product</Th><Th>SKU</Th><Th className="text-right">Physical</Th><Th className="text-right">Reserved</Th><Th className="text-right">Available</Th><Th className="text-right">Minimum</Th><Th>{''}</Th></tr></thead>
              <tbody>
                {stock.data.items.map((i: any) => (
                  <tr key={i.variant_id} className={i.is_low ? 'bg-rose-50/50' : ''}>
                    <Td><div className="font-semibold">{i.product_name}</div><div className="text-xs text-muted">{i.variant_name}{i.units_per_crate ? ` · crate of ${i.units_per_crate}` : ''}{!i.active && ' · inactive'}</div></Td>
                    <Td className="text-muted">{i.sku}</Td>
                    <Td className="text-right tabular-nums">{i.physical_stock}</Td>
                    <Td className="text-right tabular-nums">{i.reserved_stock}</Td>
                    <Td className="text-right font-bold tabular-nums">{i.available_stock} {i.is_low && <Pill tone="red">Low</Pill>}</Td>
                    <Td className="text-right tabular-nums">{i.min_stock}</Td>
                    <Td className="whitespace-nowrap text-right">
                      <Button size="sm" variant="secondary" onClick={() => { setNewStock(String(i.physical_stock)); setDialog({ kind: 'adjust', item: i }); }}>Adjust</Button>{' '}
                      <Button size="sm" variant="ghost" onClick={() => { setKind('RETURN'); setQty('1'); setDialog({ kind: 'return', item: i }); }}>Return / damage</Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      ) : (
        <Card>
          {history.isLoading ? <Spinner /> : history.error ? <div className="p-4"><ErrorBox error={history.error} /></div> : (
            <Table>
              <thead><tr><Th>When</Th><Th>Product</Th><Th>Type</Th><Th className="text-right">Physical Δ</Th><Th className="text-right">Reserved Δ</Th><Th className="text-right">Physical after</Th><Th>Order</Th><Th>By</Th><Th>Reason</Th></tr></thead>
              <tbody>
                {history.data.transactions.map((t: any) => (
                  <tr key={t.id}>
                    <Td className="whitespace-nowrap">{fmtDateTime(t.created_at)}</Td><Td>{t.product}</Td><Td><Pill tone="blue">{t.type}</Pill></Td>
                    <Td className="text-right tabular-nums">{t.physical_delta > 0 ? `+${t.physical_delta}` : t.physical_delta}</Td>
                    <Td className="text-right tabular-nums">{t.reserved_delta > 0 ? `+${t.reserved_delta}` : t.reserved_delta}</Td>
                    <Td className="text-right tabular-nums">{t.physical_after}</Td><Td>{t.order_number ?? '—'}</Td><Td>{t.user_name ?? '—'}</Td><Td className="max-w-xs truncate text-muted">{t.reason}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <Modal open={dialog?.kind === 'adjust'} onClose={() => setDialog(null)} title="Correct stock">
        {dialog && (<form className="space-y-4" onSubmit={(e) => { e.preventDefault(); adjust.mutate(); }}>
          <p className="text-sm text-muted">{dialog.item.product_name} {dialog.item.variant_name}: currently {dialog.item.physical_stock} physical, {dialog.item.reserved_stock} reserved.</p>
          <Input label={`Counted physical stock (${dialog.item.stock_unit}s)`} type="number" min={dialog.item.reserved_stock} required value={newStock} onChange={(e) => setNewStock(e.target.value)} />
          <Input label="Reason (required, recorded in audit log)" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button type="submit" loading={adjust.isPending}>Save correction</Button></div>
        </form>)}
      </Modal>

      <Modal open={dialog?.kind === 'return'} onClose={() => setDialog(null)} title="Record return or damage">
        {dialog && (<form className="space-y-4" onSubmit={(e) => { e.preventDefault(); ret.mutate(); }}>
          <p className="text-sm text-muted">{dialog.item.product_name} {dialog.item.variant_name}</p>
          <Select label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="RETURN">Returned by retailer, resellable (adds to stock)</option>
            <option value="RETURN_DAMAGED">Returned by retailer, damaged (logged only)</option>
            <option value="DAMAGED">Damaged in godown (removes from stock)</option>
          </Select>
          <Input label="Quantity" type="number" min={1} required value={qty} onChange={(e) => setQty(e.target.value)} />
          {kind !== 'DAMAGED' && <Select label="Retailer" value={retailerId} onChange={(e) => setRetailerId(e.target.value)}><option value="">Not specified</option>{retailers.data?.retailers.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}
          <Input label="Reason" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button type="submit" loading={ret.isPending}>Record</Button></div>
        </form>)}
      </Modal>
    </div>
  );
}
