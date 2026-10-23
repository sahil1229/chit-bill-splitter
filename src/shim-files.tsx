import React, { useCallback, useState } from 'react';
export function FileCard({ children }: { children?: React.ReactNode }) { return <>{children}</>; }
export function FileRouter({ children }: { children?: React.ReactNode }) { return <>{children}</>; }
const mem: Record<string, string> = {};
function get(k: string): string | null { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } }
function put(k: string, v: string) { try { localStorage.setItem(k, v); } catch { mem[k] = v; } }
export function useLocalState<T>(key: string, init: T): [T, (v: T) => void, { ready: boolean; message?: string }] {
  const [v, setV] = useState<T>(() => { try { const r = get('chit.' + key); return r ? ({ ...(init as object), ...JSON.parse(r) } as T) : init; } catch { return init; } });
  const set = useCallback((n: T) => { setV(n); try { put('chit.' + key, JSON.stringify(n)); } catch { /* ignore */ } }, [key]);
  return [v, set, { ready: true }];
}
