import { useState, type FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../auth';
import { Button, Input, useToast } from '../ui';

export default function Login() {
  const { login } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email.trim(), password);
    } catch (err: any) {
      setError(err.message ?? 'Could not log in');
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="safe-top grid min-h-screen place-items-center bg-gradient-to-b from-brand-800 to-brand-600 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-white">
          <div className="mx-auto mb-3 grid size-16 place-items-center rounded-2xl bg-white text-3xl shadow-lg">🥛</div>
          <h1 className="text-2xl font-bold">Dairy Order Desk</h1>
          <p className="mt-1 text-sm text-brand-100">Milk &amp; curd orders for retailers</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-3xl bg-white p-6 shadow-xl">
          <Input label="Email" type="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="relative">
            <Input label="Password" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} className="absolute bottom-0.5 right-1 grid size-10 place-items-center text-slate-500">
              {show ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
            </button>
          </div>
          {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{error}</p>}
          <Button type="submit" size="lg" full loading={busy}>Log in</Button>
          <p className="text-center text-xs text-muted">Forgot your password? Ask your distributor to reset it.</p>
        </form>
      </div>
    </div>
  );
}
