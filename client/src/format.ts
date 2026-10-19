const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
export const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : inr.format(Number(n)));

export const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return '—';
  const date = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`) : new Date(d);
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
export const fmtDateTime = (d: string | Date) =>
  new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: 'Submitted',
  ACCEPTED: 'Accepted',
  PREPARING: 'Preparing',
  READY_FOR_DELIVERY: 'Ready for delivery',
  PARTIALLY_DELIVERED: 'Partially delivered',
  DELIVERED: 'Delivered',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

export const DELIVERY_LABEL: Record<string, string> = { PENDING: 'Pending', DELIVERED: 'Delivered', PARTIAL: 'Partial', NONE: '—' };

export const unitLabel = (unit: string, qty = 2) => (unit === 'crate' ? (qty === 1 ? 'crate' : 'crates') : qty === 1 ? unit : unit === 'box' ? 'boxes' : `${unit}s`.replace('kgs', 'kg').replace('litres', 'litres'));

export const packLabel = (size: number, unit: string) => `${size} ${unit}`;

export const toLocalISO = (d: Date) => {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};
