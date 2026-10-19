import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface CartLine {
  variantId: number;
  unit: string; // stock unit (e.g. packet) or 'crate'
  quantity: number;
}

interface CartState {
  lines: CartLine[];
  count: number;
  qtyOf: (variantId: number, unit: string) => number;
  setQty: (variantId: number, unit: string, quantity: number) => void;
  replace: (lines: CartLine[]) => void;
  clear: () => void;
  /** Stable per-cart token so a double-tap or retry cannot create two orders. */
  submitToken: string;
  resetToken: () => void;
}

const KEY = 'amul_cart';
const Ctx = createContext<CartState>(null as any);
export const useCart = () => useContext(Ctx);

const newToken = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function load(): { lines: CartLine[]; token: string } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && Array.isArray(raw.lines)) return { lines: raw.lines, token: raw.token ?? newToken() };
  } catch {
    /* ignore */
  }
  return { lines: [], token: newToken() };
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* private mode: cart just won't persist */
    }
  }, [state]);

  const value = useMemo<CartState>(
    () => ({
      lines: state.lines,
      count: state.lines.length,
      qtyOf: (variantId, unit) => state.lines.find((l) => l.variantId === variantId && l.unit === unit)?.quantity ?? 0,
      setQty: (variantId, unit, quantity) =>
        setState((s) => {
          const rest = s.lines.filter((l) => !(l.variantId === variantId && l.unit === unit));
          return { ...s, lines: quantity > 0 ? [...rest, { variantId, unit, quantity }] : rest };
        }),
      replace: (lines) => setState((s) => ({ ...s, lines })),
      clear: () => setState({ lines: [], token: newToken() }),
      submitToken: state.token,
      resetToken: () => setState((s) => ({ ...s, token: newToken() })),
    }),
    [state],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
