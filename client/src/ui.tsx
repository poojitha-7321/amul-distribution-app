import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Minus, Plus, X } from 'lucide-react';
import { ApiError } from './api';
import { STATUS_LABEL } from './format';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- Button ----------
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  full?: boolean;
};
const BTN: Record<string, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 active:bg-brand-900',
  secondary: 'bg-white text-brand-800 border border-line hover:bg-brand-50',
  danger: 'bg-accent-500 text-white hover:bg-accent-600',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700',
  ghost: 'text-brand-700 hover:bg-brand-50',
};
export function Button({ variant = 'primary', size = 'md', loading, full, className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none',
        size === 'sm' && 'px-3 py-1.5 text-sm min-h-9',
        size === 'md' && 'px-4 py-2.5 text-sm min-h-11',
        size === 'lg' && 'px-5 py-3.5 text-base min-h-12',
        full && 'w-full',
        BTN[variant],
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

// ---------- Form fields ----------
const fieldCls = 'w-full rounded-xl border border-line bg-white px-3 py-2.5 min-h-11 text-ink placeholder:text-slate-400 focus:border-brand-500 disabled:bg-slate-50';

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">{label}</label>
      {children(id)}
      {hint && !error && <p className="mt-1 text-xs text-muted">{hint}</p>}
      {error && <p className="mt-1 text-xs text-accent-600" role="alert">{error}</p>}
    </div>
  );
}
export function Input({ label, error, hint, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  return <Field label={label} error={error} hint={hint}>{(id) => <input id={id} {...p} aria-invalid={!!error} className={cx(fieldCls, p.className)} />}</Field>;
}
export function Select({ label, error, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string }) {
  return <Field label={label} error={error}>{(id) => <select id={id} {...p} className={cx(fieldCls, p.className)}>{children}</select>}</Field>;
}
export function Textarea({ label, error, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string }) {
  return <Field label={label} error={error}>{(id) => <textarea id={id} rows={3} {...p} className={cx(fieldCls, p.className)} />}</Field>;
}
/** Bare filter control for toolbars (label via aria-label). */
export const filterCls = 'rounded-xl border border-line bg-white px-3 py-2 min-h-10 text-sm focus:border-brand-500';

// ---------- Layout bits ----------
export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('rounded-2xl border border-line bg-white shadow-sm', className)}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-brand-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  SUBMITTED: 'bg-amber-100 text-amber-800',
  ACCEPTED: 'bg-sky-100 text-sky-800',
  PREPARING: 'bg-indigo-100 text-indigo-800',
  READY_FOR_DELIVERY: 'bg-violet-100 text-violet-800',
  PARTIALLY_DELIVERED: 'bg-orange-100 text-orange-800',
  DELIVERED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  CANCELLED: 'bg-slate-200 text-slate-700',
};
export function StatusBadge({ status }: { status: string }) {
  return <span className={cx('inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold', STATUS_STYLE[status] ?? 'bg-slate-100 text-slate-700')}>{STATUS_LABEL[status] ?? status}</span>;
}
export function Pill({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'red' | 'amber' | 'blue' }) {
  const t = { slate: 'bg-slate-100 text-slate-700', green: 'bg-emerald-100 text-emerald-800', red: 'bg-rose-100 text-rose-800', amber: 'bg-amber-100 text-amber-800', blue: 'bg-brand-100 text-brand-800' }[tone];
  return <span className={cx('inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold', t)}>{children}</span>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-muted" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden /> {label}
    </div>
  );
}
export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
      {icon && <div className="text-brand-200">{icon}</div>}
      <p className="font-semibold text-slate-700">{title}</p>
      {hint && <p className="max-w-sm text-sm text-muted">{hint}</p>}
      {action}
    </div>
  );
}
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : 'Something went wrong';
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-800" role="alert">
      <AlertCircle className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="flex-1 text-sm">{msg}</div>
      {retry && <Button size="sm" variant="secondary" onClick={retry}>Retry</Button>}
    </div>
  );
}

// ---------- Quantity stepper ----------
export function Stepper({ value, onChange, min = 0, max = 100000, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label: string }) {
  const set = (n: number) => onChange(Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : min)));
  return (
    <div className="inline-flex items-center rounded-xl border border-line bg-white" role="group" aria-label={label}>
      <button type="button" aria-label={`Decrease ${label}`} onClick={() => set(value - 1)} disabled={value <= min} className="grid size-11 place-items-center rounded-l-xl text-brand-700 hover:bg-brand-50 disabled:opacity-30">
        <Minus className="size-4" />
      </button>
      <input
        inputMode="numeric"
        aria-label={label}
        value={value}
        onChange={(e) => set(Number(e.target.value.replace(/\D/g, '')))}
        onFocus={(e) => e.target.select()}
        className="h-11 w-14 border-x border-line text-center text-base font-semibold tabular-nums"
      />
      <button type="button" aria-label={`Increase ${label}`} onClick={() => set(value + 1)} disabled={value >= max} className="grid size-11 place-items-center rounded-r-xl text-brand-700 hover:bg-brand-50 disabled:opacity-30">
        <Plus className="size-4" />
      </button>
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={cx('max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl outline-none sm:rounded-3xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-brand-900">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="grid size-9 place-items-center rounded-full hover:bg-slate-100"><X className="size-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- Toasts ----------
type Toast = { id: number; kind: 'success' | 'error'; text: string };
const ToastCtx = createContext<{ success: (t: string) => void; error: (t: unknown) => void }>({ success: () => undefined, error: () => undefined });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s.slice(-2), { id, kind, text }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  const value = {
    success: (t: string) => push('success', t),
    error: (e: unknown) => push('error', e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)),
  };
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('pointer-events-auto flex max-w-md items-start gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg', t.kind === 'success' ? 'bg-emerald-600' : 'bg-rose-600')}>
            {t.kind === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertCircle className="mt-0.5 size-4 shrink-0" />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Responsive data table ----------
export function Table({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">{children}</table></div>;
}
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th scope="col" className={cx('whitespace-nowrap border-b border-line bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted', className)}>{children}</th>
);
export const Td = ({ children, className, ...p }: { children?: ReactNode; className?: string } & React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td {...p} className={cx('border-b border-line px-4 py-3 align-middle', className)}>{children}</td>
);

export function ConfirmButton({ children, message, onConfirm, ...p }: BtnProps & { message: string; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button {...p} onClick={() => setOpen(true)}>{children}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Please confirm">
        <p className="mb-5 text-sm text-slate-700">{message}</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>Go back</Button>
          <Button variant={p.variant === 'danger' ? 'danger' : 'primary'} onClick={() => { setOpen(false); onConfirm(); }}>Confirm</Button>
        </div>
      </Modal>
    </>
  );
}
