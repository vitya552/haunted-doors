export interface StoredHouse {
  address: string;
  hostKey: string;
  houseId: string;
  prizes: string[];
  salts: string[];
  openedTx: string;
}

export interface TxEntry {
  label: string;
  txId: string;
  at: number;
}

const KEY = "haunted-doors/v1";

export interface Store {
  identity: string | null;
  houses: Record<string, StoredHouse>;
  doorKeys: Record<string, Record<string, string>>;
  txs: TxEntry[];
  lastHouse: string | null;
}

const EMPTY: Store = { identity: null, houses: {}, doorKeys: {}, txs: [], lastHouse: null };

export function loadStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Store>) } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

export function saveStore(store: Store): void {
  localStorage.setItem(KEY, JSON.stringify(store));
}
