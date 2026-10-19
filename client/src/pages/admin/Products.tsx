import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { get, patch, post, put } from '../../api';
import { money } from '../../format';
import { Button, Card, ErrorBox, Input, Modal, PageHeader, Pill, Select, Spinner, Table, Td, Th, useToast } from '../../ui';

const blankVariant = { variantName: '', sku: '', packSize: '500', packSizeUnit: 'ml', stockUnit: 'packet', unitsPerCrate: '', defaultOrderUnit: 'packet', price: '', cratePrice: '', minStock: '0', openingStock: '0', active: true };

export default function Products() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['admin-products'], queryFn: () => get('/admin/products') });
  const [prod, setProd] = useState<any>(null); // product dialog
  const [vd, setVd] = useState<any>(null); // variant dialog { productId, id?, ...fields }
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['admin-products'] }); void qc.invalidateQueries({ queryKey: ['catalog'] }); void qc.invalidateQueries({ queryKey: ['inventory'] }); };

  const saveProd = useMutation({
    mutationFn: () => {
      const body = { categoryId: Number(prod.categoryId), name: prod.name, brand: prod.brand || 'Amul', description: prod.description || null, imageUrl: prod.imageUrl || null, active: prod.active };
      return prod.id ? put(`/admin/products/${prod.id}`, body) : post('/admin/products', body);
    },
    onSuccess: () => { toast.success('Product saved'); setProd(null); refresh(); }, onError: toast.error,
  });
  const saveVariant = useMutation({
    mutationFn: () => {
      const n = (s: string) => (s === '' ? null : Number(s));
      const body = {
        variantName: vd.variantName, sku: vd.sku, packSize: Number(vd.packSize), packSizeUnit: vd.packSizeUnit, stockUnit: vd.stockUnit,
        unitsPerCrate: n(vd.unitsPerCrate), defaultOrderUnit: vd.defaultOrderUnit, price: n(vd.price), cratePrice: n(vd.cratePrice),
        minStock: Number(vd.minStock), openingStock: Number(vd.openingStock), active: vd.active,
      };
      return vd.id ? put(`/admin/variants/${vd.id}`, body) : post(`/admin/products/${vd.productId}/variants`, body);
    },
    onSuccess: () => { toast.success('Variant saved'); setVd(null); refresh(); }, onError: toast.error,
  });
  const toggle = useMutation({
    mutationFn: ({ kind, id, active }: { kind: 'products' | 'variants'; id: number; active: boolean }) => patch(`/admin/${kind}/${id}/active`, { active }),
    onSuccess: refresh, onError: toast.error,
  });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} retry={refetch} />;
  const cats = data.categories.filter((c: any) => c.active);
  const sv = (k: string) => (e: any) => setVd({ ...vd, [k]: e.target.value });

  return (
    <div>
      <PageHeader title="Products" subtitle="Milk and curd catalogue. Stock quantities are managed under Inventory."
        actions={<Button onClick={() => setProd({ categoryId: cats[0]?.id, name: '', brand: 'Amul', description: '', imageUrl: '', active: true })}><Plus className="size-4" /> Add product</Button>} />
      <div className="space-y-4">
        {data.products.map((p: any) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line p-4">
              <div>
                <h2 className="font-bold text-brand-900">{p.name} <span className="font-normal text-muted">· {p.categoryName}</span> {!p.active && <Pill tone="slate">Inactive</Pill>}</h2>
                {p.description && <p className="text-sm text-muted">{p.description}</p>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setProd({ ...p, categoryId: p.categoryId, imageUrl: p.imageUrl ?? '', description: p.description ?? '' })}><Pencil className="size-4" /> Edit</Button>
                <Button size="sm" variant="secondary" onClick={() => toggle.mutate({ kind: 'products', id: p.id, active: !p.active })}>{p.active ? 'Deactivate' : 'Activate'}</Button>
                <Button size="sm" onClick={() => setVd({ ...blankVariant, productId: p.id })}><Plus className="size-4" /> Variant</Button>
              </div>
            </div>
            <Table>
              <thead><tr><Th>Variant</Th><Th>SKU</Th><Th>Pack</Th><Th>Crate</Th><Th className="text-right">Price</Th><Th className="text-right">Stock</Th><Th>Status</Th><Th>{''}</Th></tr></thead>
              <tbody>
                {p.variants.map((v: any) => (
                  <tr key={v.id}>
                    <Td className="font-medium">{v.name}</Td><Td className="text-muted">{v.sku}</Td>
                    <Td>{v.packSize} {v.packSizeUnit}</Td><Td>{v.unitsPerCrate ? `${v.unitsPerCrate} / crate` : '—'}</Td>
                    <Td className="text-right">{money(v.price)}</Td><Td className="text-right tabular-nums">{v.physicalStock} <span className="text-xs text-muted">({v.reservedStock} res.)</span></Td>
                    <Td>{v.active ? <Pill tone="green">Active</Pill> : <Pill>Inactive</Pill>}</Td>
                    <Td className="whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" onClick={() => setVd({ ...blankVariant, id: v.id, productId: p.id, variantName: v.name, sku: v.sku, packSize: String(v.packSize), packSizeUnit: v.packSizeUnit, stockUnit: v.stockUnit, unitsPerCrate: v.unitsPerCrate ?? '', defaultOrderUnit: v.defaultOrderUnit, price: v.price ?? '', cratePrice: v.cratePrice ?? '', minStock: String(v.minStock), active: v.active })}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ kind: 'variants', id: v.id, active: !v.active })}>{v.active ? 'Deactivate' : 'Activate'}</Button>
                    </Td>
                  </tr>
                ))}
                {p.variants.length === 0 && <tr><Td colSpan={8} className="py-6 text-center text-muted">No variants yet.</Td></tr>}
              </tbody>
            </Table>
          </Card>
        ))}
      </div>

      <Modal open={!!prod} onClose={() => setProd(null)} title={prod?.id ? 'Edit product' : 'Add product'}>
        {prod && (<form className="space-y-4" onSubmit={(e) => { e.preventDefault(); saveProd.mutate(); }}>
          <Select label="Category" value={prod.categoryId} onChange={(e) => setProd({ ...prod, categoryId: e.target.value })}>{cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          <Input label="Product name" required value={prod.name} onChange={(e) => setProd({ ...prod, name: e.target.value })} />
          <Input label="Brand" value={prod.brand} onChange={(e) => setProd({ ...prod, brand: e.target.value })} />
          <Input label="Description (optional)" value={prod.description} onChange={(e) => setProd({ ...prod, description: e.target.value })} />
          <Input label="Image URL (optional)" type="url" value={prod.imageUrl} onChange={(e) => setProd({ ...prod, imageUrl: e.target.value })} hint="Leave empty to show a placeholder" />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setProd(null)}>Cancel</Button><Button type="submit" loading={saveProd.isPending}>Save</Button></div>
        </form>)}
      </Modal>

      <Modal wide open={!!vd} onClose={() => setVd(null)} title={vd?.id ? 'Edit variant' : 'Add variant'}>
        {vd && (<form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); saveVariant.mutate(); }}>
          <Input label="Variant name" required placeholder="500 ml pouch" value={vd.variantName} onChange={sv('variantName')} />
          <Input label="SKU / product code" required value={vd.sku} onChange={sv('sku')} />
          <Input label="Pack size" type="number" step="any" min="0" required value={vd.packSize} onChange={sv('packSize')} />
          <Select label="Pack size unit" value={vd.packSizeUnit} onChange={sv('packSizeUnit')}>{['ml', 'l', 'g', 'kg', 'pcs'].map((u) => <option key={u}>{u}</option>)}</Select>
          <Select label="Stock is counted in" value={vd.stockUnit} onChange={(e) => setVd({ ...vd, stockUnit: e.target.value, defaultOrderUnit: e.target.value })}>{['packet', 'piece', 'box', 'litre', 'kg', 'g'].map((u) => <option key={u}>{u}</option>)}</Select>
          <Input label="Units per crate (optional)" type="number" min="2" value={vd.unitsPerCrate} onChange={(e) => setVd({ ...vd, unitsPerCrate: e.target.value, defaultOrderUnit: e.target.value ? vd.defaultOrderUnit : vd.stockUnit })} hint="Set only if this product is sold in crates" />
          <Select label="Default order unit" value={vd.defaultOrderUnit} onChange={sv('defaultOrderUnit')}><option value={vd.stockUnit}>{vd.stockUnit}</option>{vd.unitsPerCrate && <option value="crate">crate</option>}</Select>
          <Input label={`Price per ${vd.stockUnit} (₹, optional)`} type="number" step="0.01" min="0" value={vd.price} onChange={sv('price')} />
          <Input label="Crate price (₹, optional)" type="number" step="0.01" min="0" value={vd.cratePrice} onChange={sv('cratePrice')} hint="Blank = price × units per crate" />
          <Input label="Minimum stock alert" type="number" min="0" required value={vd.minStock} onChange={sv('minStock')} />
          {!vd.id && <Input label="Opening stock" type="number" min="0" required value={vd.openingStock} onChange={sv('openingStock')} hint="Later changes go through Inventory adjustments" />}
          <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="secondary" onClick={() => setVd(null)}>Cancel</Button><Button type="submit" loading={saveVariant.isPending}>Save variant</Button></div>
        </form>)}
      </Modal>
    </div>
  );
}
