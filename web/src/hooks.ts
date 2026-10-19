import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as O from "./lib/ootle";
import { loadStore, saveStore, type Store } from "./store";

export function useStore() {
  const [store, setStore] = useState<Store>(() => loadStore());
  const update = useCallback((fn: (s: Store) => Store) => {
    setStore((prev) => {
      const next = fn(prev);
      saveStore(next);
      return next;
    });
  }, []);
  return { store, update };
}

export function useProvider() {
  const [provider, setProvider] = useState<O.IndexerProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    O.connect()
      .then((p) => live && setProvider(p))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  return { provider, error };
}

export function useIdentity(store: Store, update: (fn: (s: Store) => Store) => void) {
  const identity = useMemo(() => (store.identity ? O.importIdentity(store.identity) : null), [store.identity]);
  const create = useCallback(() => update((s) => ({ ...s, identity: O.exportIdentity(O.newIdentity()) })), [update]);
  const restore = useCallback((encoded: string) => update((s) => ({ ...s, identity: O.exportIdentity(O.importIdentity(encoded.trim())) })), [update]);
  const forget = useCallback(() => update((s) => ({ ...s, identity: null })), [update]);
  return { identity, create, restore, forget };
}

export interface Balance {
  utxos: O.OwnedUtxo[];
  total: bigint;
  scanned: number;
  scanning: boolean;
  error: string | null;
}

export function useBalance(provider: O.IndexerProvider | null, identity: O.Identity | null) {
  const [balance, setBalance] = useState<Balance>({ utxos: [], total: 0n, scanned: 0, scanning: false, error: null });
  const running = useRef(false);
  const refresh = useCallback(async () => {
    if (!provider || !identity || running.current) return;
    running.current = true;
    setBalance((b) => ({ ...b, scanning: true, error: null }));
    try {
      const owned = await O.scanOwnedUtxos(identity, O.INDEXER_URL, (n) => setBalance((b) => ({ ...b, scanned: n })));
      const utxos = await O.filterUnspent(provider, owned);
      setBalance({ utxos, total: utxos.reduce((n, u) => n + u.value, 0n), scanned: 0, scanning: false, error: null });
    } catch (e) {
      setBalance((b) => ({ ...b, scanning: false, error: (e as Error).message }));
    } finally {
      running.current = false;
    }
  }, [provider, identity]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { balance, refresh };
}

export function useAction() {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = status !== null;
  const run = useCallback(async <T,>(fn: (onStatus: (s: string) => void) => Promise<T>): Promise<T | null> => {
    setError(null);
    setStatus("working");
    try {
      return await fn(setStatus);
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setStatus(null);
    }
  }, []);
  return { status, error, busy, run, clearError: () => setError(null) };
}
