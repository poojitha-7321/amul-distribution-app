import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { get, patch, post, put } from '../../api';
import { Button, Card, ConfirmButton, ErrorBox, Input, Modal, PageHeader, Pill, Spinner, Table, Td, Textarea, Th, useToast } from '../../ui';

export default function Retailers() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['retailers'], queryFn: () => get('/admin/retailers') });
  const [form, setForm] = useState<any>(null);
  const [secret, setSecret] = useState<{ title: string; email: string; password: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['retailers'] });

  const save = useMutation({
    mutationFn: () => form.id
      ? put(`/admin/retailers/${form.id}`, { name: form.name, ownerName: form.owner_name || null, phone: form.phone || null, address: form.address || null })
      : post('/admin/retailers', { name: form.name, ownerName: form.owner_name || undefined, phone: form.phone || undefined, address: form.address || undefined, email: form.email }),
    onSuccess: (r: any) => {
      refresh();
      if (r.temporaryPassword) setSecret({ title: 'Retailer created', email: form.email, password: r.temporaryPassword });
      else toast.success('Saved');
      setForm(null);
    },
    onError: toast.error,
  });
  const toggle = useMutation({ mutationFn: (v: { id: number; active: boolean }) => patch(`/admin/retailers/${v.id}/active`, { active: v.active }), onSuccess: refresh, onError: toast.error });
  const reset = useMutation({
    mutationFn: (r: any) => post(`/admin/retailers/${r.id}/reset-password`).then((x) => ({ ...x, email: r.email })),
    onSuccess: (x: any) => setSecret({ title: 'Password reset', email: x.email, password: x.temporaryPassword }),
    onError: toast.error,
  });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} retry={refetch} />;
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  return (
    <div>
      <PageHeader title="Retailers" subtitle="Each retailer has their own login" actions={<Button onClick={() => setForm({ name: '', owner_name: '', phone: '', address: '', email: '' })}><Plus className="size-4" /> Add retailer</Button>} />
      <Card>
        <Table>
          <thead><tr><Th>Retailer</Th><Th>Login email</Th><Th>Phone</Th><Th className="text-right">Orders</Th><Th>Status</Th><Th>{''}</Th></tr></thead>
          <tbody>
            {data.retailers.map((r: any) => (
              <tr key={r.id}>
                <Td><div className="font-semibold">{r.name}</div><div className="text-xs text-muted">{r.owner_name}{r.address ? ` · ${r.address}` : ''}</div></Td>
                <Td>{r.email}</Td><Td>{r.phone ?? '—'}</Td><Td className="text-right">{r.order_count}</Td>
                <Td>{r.active ? <Pill tone="green">Active</Pill> : <Pill>Inactive</Pill>}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setForm(r)}>Edit</Button>
                  <ConfirmButton size="sm" variant="ghost" message={`Reset the password for ${r.name}? They will be signed out and must use the new temporary password.`} onConfirm={() => reset.mutate(r)}><KeyRound className="size-4" /> Reset password</ConfirmButton>
                  <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ id: r.id, active: !r.active })}>{r.active ? 'Deactivate' : 'Activate'}</Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit retailer' : 'Add retailer'}>
        {form && (<form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Input label="Shop name" required value={form.name} onChange={set('name')} />
          <Input label="Owner / contact name" value={form.owner_name ?? ''} onChange={set('owner_name')} />
          {!form.id && <Input label="Login email" type="email" required value={form.email} onChange={set('email')} hint="A temporary password is generated for the first login" />}
          <Input label="Phone" type="tel" value={form.phone ?? ''} onChange={set('phone')} />
          <Textarea label="Address" value={form.address ?? ''} onChange={set('address')} />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></div>
        </form>)}
      </Modal>

      <Modal open={!!secret} onClose={() => setSecret(null)} title={secret?.title ?? ''}>
        {secret && (<div className="space-y-4">
          <p className="text-sm text-muted">Share these credentials with the retailer. The password is shown <strong>only once</strong> and they must change it at first login.</p>
          <div className="rounded-xl bg-slate-50 p-4 font-mono text-sm"><div>Email: {secret.email}</div><div>Password: <strong>{secret.password}</strong></div></div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(`Email: ${secret.email}\nPassword: ${secret.password}`); toast.success('Copied'); }}><Copy className="size-4" /> Copy</Button>
            <Button onClick={() => setSecret(null)}>Done</Button>
          </div>
        </div>)}
      </Modal>
    </div>
  );
}
