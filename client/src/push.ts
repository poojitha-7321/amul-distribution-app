import { useCallback, useEffect, useState } from 'react';
import { get, post } from './api';

export type PushState = 'unsupported' | 'unconfigured' | 'blocked' | 'off' | 'on' | 'loading';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyToUint8(base64: string) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function usePush() {
  const [state, setState] = useState<PushState>('loading');

  const refresh = useCallback(async () => {
    if (!supported()) return setState('unsupported');
    if (Notification.permission === 'denied') return setState('blocked');
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      setState(existing && Notification.permission === 'granted' ? 'on' : 'off');
    } catch {
      setState('off');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Must be called from a tap/click: browsers only show the permission prompt for a user gesture. */
  const enable = useCallback(async () => {
    const cfg = await get<{ enabled: boolean; publicKey: string | null }>('/push/public-key');
    if (!cfg.enabled || !cfg.publicKey) { setState('unconfigured'); return; }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { setState(permission === 'denied' ? 'blocked' : 'off'); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToUint8(cfg.publicKey) }));
    await post('/push/subscribe', sub.toJSON());
    setState('on');
  }, []);

  const disable = useCallback(async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
      await sub.unsubscribe();
    }
    setState('off');
  }, []);

  const sendTest = useCallback(() => post('/push/test'), []);
  return { state, enable, disable, sendTest };
}
