import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ANALYSTS, getActor, setActor as persistActor } from './api.js';

const AppCtx = createContext(null);

export function AppProvider({ children }) {
  const [actor, setActorState] = useState(getActor());
  const [theme, setTheme] = useState(() => localStorage.getItem('signal-loop.theme') || 'auto');
  const [toasts, setToasts] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const setActor = useCallback((name) => {
    persistActor(name);
    setActorState(name);
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    localStorage.setItem('signal-loop.theme', theme);
  }, [theme]);

  const toast = useCallback((message, kind = 'info', detail) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list, { id, message, kind, detail }]);
    setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
    }, kind === 'danger' ? 7000 : 4200);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const invalidate = useCallback(() => setRefreshKey((k) => k + 1), []);

  const value = useMemo(() => ({
    actor, setActor, analysts: ANALYSTS, theme, setTheme,
    toast, toasts, dismissToast, refreshKey, invalidate,
  }), [actor, setActor, theme, toast, toasts, dismissToast, refreshKey, invalidate]);

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp() {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}

/** 简单数据获取：refreshKey 变化时重新拉取。 */
export function useFetch(fn, deps = [], { skip = false } = {}) {
  const { refreshKey } = useApp();
  const [state, setState] = useState({ data: null, loading: !skip, error: null });
  const [localKey, setLocalKey] = useState(0);

  useEffect(() => {
    if (skip) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve()
      .then(fn)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((error) => {
        if (!cancelled) setState({ data: null, loading: false, error });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, localKey, skip, ...deps]);

  const reload = useCallback(() => setLocalKey((k) => k + 1), []);
  return { ...state, reload };
}
