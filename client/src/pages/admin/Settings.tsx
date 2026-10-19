import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../../api';
import { fmtDateTime } from '../../format';
import { Button, Card, ErrorBox, Input, PageHeader, Select, Spinner, Table, Td, Th, useToast } from '../../ui';

export default function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') });
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => get('/admin/audit') });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data) setF({ insufficientStockPolicy: data.insufficientStockPolicy, retailerCancelUntil: data.retailerCancelUntil, maxDeliveryDaysAhead: String(data.maxDeliveryDaysAhead) }); }, [data]);
  const save = useMutation({
    mutationFn: () => put('/settings', { ...f, maxDeliveryDaysAhead: Number(f.maxDeliveryDaysAhead) }),
    onSuccess: () => { toast.success('Settings saved'); void qc.invalidateQueries({ queryKey: ['settings'] }); }, onError: toast.error,
  });
  if (isLoading || !f) return <Spinner />;
  if (error) return <ErrorBox error={error} retry={refetch} />;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />
      <Card className="max-w-2xl space-y-4 p-5">
        <h2 className="font-bold text-brand-900">Ordering policy</h2>
        <Select label="When stock is insufficient" value={f.insufficientStockPolicy} onChange={(e) => setF({ ...f, insufficientStockPolicy: e.target.value })}>
          <option value="block">Block: retailers cannot order more than is available; accepting needs full stock</option>
          <option value="partial">Allow: retailers can order; accepting reserves whatever is available</option>
        </Select>
        <Select label="Retailers may cancel until" value={f.retailerCancelUntil} onChange={(e) => setF({ ...f, retailerCancelUntil: e.target.value })}>
          <option value="SUBMITTED">Order is accepted (only while submitted)</option>
          <option value="ACCEPTED">Order starts being prepared (submitted or accepted)</option>
        </Select>
        <Input label="Furthest delivery date retailers can pick (days ahead)" type="number" min={1} max={60} value={f.maxDeliveryDaysAhead} onChange={(e) => setF({ ...f, maxDeliveryDaysAhead: e.target.value })} />
        <div className="flex gap-2"><Button loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button><Link to="/account/password"><Button variant="secondary">Change my password</Button></Link></div>
      </Card>

      <Card>
        <div className="border-b border-line p-4"><h2 className="font-bold text-brand-900">Audit log</h2><p className="text-sm text-muted">Latest 200 sensitive actions (stock, deliveries, imports, logins)</p></div>
        {audit.isLoading ? <Spinner /> : (
          <Table>
            <thead><tr><Th>When</Th><Th>User</Th><Th>Action</Th><Th>Entity</Th></tr></thead>
            <tbody>{audit.data?.logs.map((l: any) => <tr key={l.id}><Td className="whitespace-nowrap">{fmtDateTime(l.created_at)}</Td><Td>{l.user_name ?? '—'}</Td><Td className="font-mono text-xs">{l.action}</Td><Td>{l.entity} {l.entity_id}</Td></tr>)}</tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
