import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post } from './api';

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'retailer';
  retailerId: number | null;
  retailerName: string | null;
  mustChangePassword: boolean;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    try {
      setUser((await get<{ user: User }>('/auth/me')).user);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.warn(e);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const expired = () => { setUser(null); qc.clear(); };
    window.addEventListener('auth:expired', expired);
    return () => window.removeEventListener('auth:expired', expired);
  }, [refresh, qc]);

  const login = async (email: string, password: string) => {
    const { user } = await post<{ user: User }>('/auth/login', { email, password });
    qc.clear();
    setUser(user);
    return user;
  };
  const logout = async () => {
    await post('/auth/logout').catch(() => undefined);
    qc.clear();
    localStorage.removeItem('amul_cart');
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, login, logout, refresh }}>{children}</Ctx.Provider>;
}
