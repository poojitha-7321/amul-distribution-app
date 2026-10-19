import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { post } from '../api';
import { useAuth } from '../auth';
import { Button, Card, Input, PageHeader, useToast } from '../ui';

export default function ChangePassword({ forced }: { forced?: boolean }) {
  const { refresh, logout } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = again.length > 0 && again !== next;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    try {
      await post('/auth/change-password', { currentPassword: cur, newPassword: next });
      toast.success('Password changed');
      await refresh();
      if (!forced) nav(-1);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <form onSubmit={submit} className="space-y-4">
      <Input label={forced ? 'Temporary password' : 'Current password'} type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} />
      <Input label="New password" type="password" autoComplete="new-password" minLength={8} required hint="At least 8 characters" value={next} onChange={(e) => setNext(e.target.value)} />
      <Input label="Repeat new password" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} error={mismatch ? 'Passwords do not match' : undefined} />
      <Button type="submit" full size="lg" loading={busy} disabled={mismatch}>Save password</Button>
    </form>
  );

  if (forced) {
    return (
      <div className="grid min-h-screen place-items-center bg-surface px-4">
        <Card className="w-full max-w-sm p-6">
          <h1 className="text-xl font-bold text-brand-900">Set your password</h1>
          <p className="mb-4 mt-1 text-sm text-muted">For your security, choose a new password before continuing.</p>
          {form}
          <button onClick={logout} className="mt-4 w-full text-center text-sm text-muted underline">Log out</button>
        </Card>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-sm">
      <PageHeader title="Change password" />
      <Card className="p-5">{form}</Card>
    </div>
  );
}
