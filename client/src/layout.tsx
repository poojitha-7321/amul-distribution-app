import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Bell, Boxes, ClipboardList, Home, LayoutDashboard, LogOut, Menu, Package, Settings, ShoppingCart, Store, Upload, X } from 'lucide-react';
import { get, post } from './api';
import { useAuth } from './auth';
import { useCart } from './cart';
import { fmtDateTime } from './format';
import { cx } from './ui';

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => get('/notifications'), refetchInterval: 30000 });
  const readAll = useMutation({ mutationFn: () => post('/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const unread = data?.unread ?? 0;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} className="relative grid size-11 place-items-center rounded-full hover:bg-white/10 lg:hover:bg-slate-100">
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute right-1.5 top-1.5 grid min-w-5 place-items-center rounded-full bg-accent-500 px-1 text-[11px] font-bold leading-5 text-white">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-white text-ink shadow-xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span className="font-semibold">Notifications</span>
              {unread > 0 && <button onClick={() => readAll.mutate()} className="text-sm font-medium text-brand-700">Mark all read</button>}
            </div>
            <ul className="max-h-96 overflow-y-auto">
              {(data?.notifications ?? []).length === 0 && <li className="px-4 py-8 text-center text-sm text-muted">Nothing yet</li>}
              {(data?.notifications ?? []).map((n: any) => (
                <li key={n.id}>
                  <button
                    onClick={() => {
                      setOpen(false);
                      void post(`/notifications/${n.id}/read`).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
                      if (n.link) nav(n.link);
                    }}
                    className={cx('block w-full border-b border-line px-4 py-3 text-left hover:bg-slate-50', !n.read && 'bg-brand-50/60')}
                  >
                    <div className="flex items-start gap-2">
                      {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent-500" />}
                      <div>
                        <div className="text-sm font-semibold">{n.title}</div>
                        {n.body && <div className="text-sm text-muted">{n.body}</div>}
                        <div className="mt-0.5 text-xs text-slate-400">{fmtDateTime(n.created_at)}</div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Retailer
const retailerNav = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/catalogue', label: 'Order', icon: Package },
  { to: '/cart', label: 'Cart', icon: ShoppingCart },
  { to: '/orders', label: 'My orders', icon: ClipboardList },
];

export function RetailerLayout() {
  const { user, logout } = useAuth();
  const cart = useCart();
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col bg-surface lg:max-w-5xl">
      <header className="safe-top sticky top-0 z-20 bg-brand-800 text-white">
        <div className="flex items-center justify-between px-4 py-2">
          <div className="min-w-0">
            <div className="text-xs text-brand-200">Welcome</div>
            <div className="truncate font-semibold">{user?.retailerName}</div>
          </div>
          <div className="flex items-center gap-1">
            <NotificationBell />
            <button onClick={logout} aria-label="Log out" className="grid size-11 place-items-center rounded-full hover:bg-white/10"><LogOut className="size-5" /></button>
          </div>
        </div>
        {/* Desktop/tablet tabs */}
        <nav className="hidden gap-1 px-4 pb-2 sm:flex" aria-label="Main">
          {retailerNav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('rounded-lg px-3 py-1.5 text-sm font-medium', isActive ? 'bg-white text-brand-800' : 'text-brand-100 hover:bg-white/10')}>
              {n.label}{n.to === '/cart' && cart.count > 0 ? ` (${cart.count})` : ''}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 px-4 pb-28 pt-5 sm:pb-10"><Outlet /></main>
      {/* Mobile bottom tab bar */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white sm:hidden" aria-label="Main">
        <ul className="mx-auto grid max-w-3xl grid-cols-4">
          {retailerNav.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={n.end} className={({ isActive }) => cx('relative flex min-h-16 flex-col items-center justify-center gap-0.5 text-xs font-medium', isActive ? 'text-brand-700' : 'text-slate-500')}>
                <n.icon className="size-6" aria-hidden />
                {n.label}
                {n.to === '/cart' && cart.count > 0 && <span className="absolute right-[26%] top-1.5 grid min-w-5 place-items-center rounded-full bg-accent-500 px-1 text-[11px] font-bold leading-5 text-white">{cart.count}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

// ------------------------------------------------------------------- Admin
const adminNav = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/orders', label: 'Orders', icon: ClipboardList },
  { to: '/admin/inventory', label: 'Inventory', icon: Boxes },
  { to: '/admin/products', label: 'Products', icon: Package },
  { to: '/admin/import', label: 'Import', icon: Upload },
  { to: '/admin/retailers', label: 'Retailers', icon: Store },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3 },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const [menu, setMenu] = useState(false);
  const links = (
    <ul className="space-y-1">
      {adminNav.map((n) => (
        <li key={n.to}>
          <NavLink to={n.to} end={n.end} onClick={() => setMenu(false)} className={({ isActive }) => cx('flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium', isActive ? 'bg-white text-brand-800' : 'text-brand-100 hover:bg-white/10')}>
            <n.icon className="size-5" aria-hidden /> {n.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-60 shrink-0 flex-col bg-brand-800 p-4 text-white lg:flex">
        <div className="mb-6 flex items-center gap-2 px-2 text-lg font-bold"><span className="grid size-9 place-items-center rounded-xl bg-white text-brand-800">🥛</span> Order Desk</div>
        <nav aria-label="Main" className="flex-1">{links}</nav>
        <div className="mt-4 border-t border-white/15 pt-3 text-sm">
          <div className="truncate px-2 text-brand-100">{user?.name}</div>
          <button onClick={logout} className="mt-1 flex min-h-10 w-full items-center gap-2 rounded-xl px-2 text-brand-100 hover:bg-white/10"><LogOut className="size-4" /> Log out</button>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="safe-top sticky top-0 z-20 flex items-center justify-between bg-brand-800 px-3 py-2 text-white lg:bg-white lg:text-ink lg:shadow-sm">
          <button onClick={() => setMenu(true)} aria-label="Open menu" className="grid size-11 place-items-center rounded-full hover:bg-white/10 lg:hidden"><Menu className="size-6" /></button>
          <div className="font-semibold lg:hidden">Order Desk</div>
          <div className="hidden text-sm text-muted lg:block">Distributor console</div>
          <NotificationBell />
        </header>
        <main className="mx-auto max-w-7xl p-4 pb-16 sm:p-6"><Outlet /></main>
      </div>

      {menu && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setMenu(false)} />
          <div className="safe-top absolute inset-y-0 left-0 w-72 bg-brand-800 p-4 text-white">
            <div className="mb-4 flex items-center justify-between"><span className="text-lg font-bold">Order Desk</span><button onClick={() => setMenu(false)} aria-label="Close menu" className="grid size-10 place-items-center rounded-full hover:bg-white/10"><X className="size-5" /></button></div>
            {links}
            <button onClick={logout} className="mt-6 flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-brand-100 hover:bg-white/10"><LogOut className="size-4" /> Log out</button>
          </div>
        </div>
      )}
    </div>
  );
}
