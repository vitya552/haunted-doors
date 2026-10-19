import { useCallback, useEffect, useState } from "react";
import * as O from "./lib/ootle";
import * as G from "./lib/game";
import { randomBytes, bytesToHex, hexToBytes } from "./lib/bytes";
import { useAction, useBalance, useIdentity, useProvider, useStore } from "./hooks";
import { short, tari, toMicro } from "./format";
import type { Store, TxEntry } from "./store";

const DEMO_HOUSE = "component_ed3f54960db166d35ae0211b1ee8335783ecb97d92a3712e7460b79b0c52d0c6";
const FAUCET = "https://testnet-faucet.taritracker.com/";

type Tab = "play" | "host" | "wallet";

export function App() {
  const { store, update } = useStore();
  const { provider, error: providerError } = useProvider();
  const { identity, create, restore, forget } = useIdentity(store, update);
  const { balance, refresh } = useBalance(provider, identity);
  const [tab, setTab] = useState<Tab>(identity ? "play" : "wallet");
  const [epoch, setEpoch] = useState<number | null>(null);

  useEffect(() => {
    if (!provider) return;
    const tick = () => provider.getCurrentEpoch().then(setEpoch).catch(() => undefined);
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [provider]);

  const logTx = useCallback(
    (label: string, txId: string) => update((s) => ({ ...s, txs: [{ label, txId, at: Date.now() }, ...s.txs].slice(0, 50) })),
    [update],
  );

  return (
    <div className="shell">
      <div className="hero" aria-hidden="true" />
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /></span>
          <div>
            <h1>Haunted Doors</h1>
            <p>a confidential trick-or-treat on Tari Ootle · Esmeralda testnet</p>
          </div>
        </div>
        <nav className="tabs">
          {(["play", "host", "wallet"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {t === "play" ? "Knock" : t === "host" ? "Haunt" : "Wallet"}
            </button>
          ))}
        </nav>
        <div className="chain">
          <span className={provider ? "dot ok" : "dot"} />
          {providerError ? "indexer offline" : provider ? `epoch ${epoch ?? "…"}` : "connecting…"}
          {identity && (
            <span className="balance" onClick={refresh} title="rescan stealth outputs">
              {balance.scanning ? `scanning ${balance.scanned}…` : `${tari(balance.total)} tXTR`}
            </span>
          )}
        </div>
      </header>

      <main>
        {tab === "wallet" && (
          <WalletPanel identity={identity} create={create} restore={restore} forget={forget} balance={balance} refresh={refresh} />
        )}
        {tab === "play" && (
          <PlayPanel provider={provider} identity={identity} store={store} update={update} balance={balance} refresh={refresh} epoch={epoch} logTx={logTx} />
        )}
        {tab === "host" && (
          <HostPanel provider={provider} identity={identity} store={store} update={update} balance={balance} refresh={refresh} epoch={epoch} logTx={logTx} />
        )}
      </main>

      <TxLog txs={store.txs} />

      <footer>
        <a href="https://community.tari.com/t/october-build-contest-thread-spooky-secrets/396" target="_blank" rel="noreferrer">Spooky Secrets</a>
        <span>·</span>
        <a href={G.templateUrl(G.TEMPLATE)} target="_blank" rel="noreferrer">template {short(G.TEMPLATE.replace("template_", ""), 6, 4)}</a>
        <span>·</span>
        <span>keys never leave this browser</span>
      </footer>
    </div>
  );
}

interface Common {
  provider: O.IndexerProvider | null;
  identity: O.Identity | null;
  store: Store;
  update: (fn: (s: Store) => Store) => void;
  balance: ReturnType<typeof useBalance>["balance"];
  refresh: () => Promise<void>;
  epoch: number | null;
  logTx: (label: string, txId: string) => void;
}

function WalletPanel({
  identity,
  create,
  restore,
  forget,
  balance,
  refresh,
}: {
  identity: O.Identity | null;
  create: () => void;
  restore: (s: string) => void;
  forget: () => void;
  balance: Common["balance"];
  refresh: () => Promise<void>;
}) {
  const [seed, setSeed] = useState("");
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!identity) {
    return (
      <section className="card">
        <h2>Bring a lantern</h2>
        <p>Haunted Doors runs on a stealth wallet that lives only in this browser. Nobody - not the host, not the house - learns which account you are.</p>
        <div className="row">
          <button className="primary" onClick={create}>Create a fresh wallet</button>
        </div>
        <details>
          <summary>Restore from a backup string</summary>
          <textarea value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="ownerSecretHex:viewSecretHex" />
          <button onClick={() => seed && restore(seed)}>Restore</button>
        </details>
      </section>
    );
  }
  const backup = O.exportIdentity(identity);
  return (
    <section className="card">
      <h2>Your stealth wallet</h2>
      <label>Receive address (paste it into the faucet)</label>
      <div className="addr">
        <code>{identity.ownerAddress}</code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(identity.ownerAddress);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <div className="row stats">
        <div>
          <b>{tari(balance.total)}</b> tXTR spendable
        </div>
        <div>
          <b>{balance.utxos.length}</b> stealth outputs
        </div>
        <button onClick={refresh} disabled={balance.scanning}>
          {balance.scanning ? `scanning ${balance.scanned}…` : "rescan"}
        </button>
      </div>
      {balance.error && <p className="error">{balance.error}</p>}
      <p>
        Need test coins? Get up to 1,000 tXTR from the{" "}
        <a href={FAUCET} target="_blank" rel="noreferrer">community faucet</a>
        . Faucet coins arrive as a private output - the chain shows neither the amount nor you. Rescan after a minute.
      </p>
      <details>
        <summary>Backup and danger zone</summary>
        <p>Back up this string somewhere safe. Anyone holding it holds your coins.</p>
        <div className="addr">
          <code>{reveal ? backup : "•".repeat(48)}</code>
          <button onClick={() => setReveal(!reveal)}>{reveal ? "hide" : "show"}</button>
        </div>
        <button className="danger" onClick={() => confirm("Forget this wallet in this browser?") && forget()}>
          Forget wallet
        </button>
      </details>
    </section>
  );
}

function doorLabel(door: G.DoorState, mine: boolean, epoch: number | null, house: G.HouseState) {
  if (!door.player) return { cls: "closed", text: "closed" };
  if (door.prize === null) {
    const late = epoch !== null && BigInt(epoch) > door.knockedAt + house.revealWindow;
    return { cls: late ? "late" : "knocked", text: late ? (mine ? "host is silent - claim refund" : "host is silent") : mine ? "you knocked - waiting for the host" : "knocked" };
  }
  if (door.prize === 0n) return { cls: "trick", text: door.settled ? "trick" : "trick (unsettled)" };
  if (door.settled) return { cls: "treat", text: `treat · ${tari(door.prize)} tXTR paid` };
  return { cls: "treat", text: mine ? `treat · ${tari(door.prize)} tXTR - claim it` : `treat · ${tari(door.prize)} tXTR` };
}

function PlayPanel({ provider, identity, store, update, balance, refresh, epoch, logTx }: Common) {
  const [address, setAddress] = useState(store.lastHouse ?? DEMO_HOUSE);
  const [house, setHouse] = useState<G.HouseState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const action = useAction();

  const load = useCallback(
    async (addr: string) => {
      setLoadError(null);
      try {
        const h = await G.fetchHouse(addr.trim());
        setHouse(h);
        update((s) => ({ ...s, lastHouse: addr.trim() }));
      } catch (e) {
        setHouse(null);
        setLoadError((e as Error).message);
      }
    },
    [update],
  );

  useEffect(() => {
    void load(address);
  }, []);

  const myKeys = house ? (store.doorKeys[house.address] ?? {}) : {};

  const knock = async (door: number) => {
    if (!provider || !identity || !house) return;
    const key = G.freshKey();
    update((s) => ({ ...s, doorKeys: { ...s.doorKeys, [house.address]: { ...(s.doorKeys[house.address] ?? {}), [door]: G.keyHex(key) } } }));
    const result = await action.run(async (onStatus) => {
      onStatus("choosing coins");
      const inputs = O.pickInputs(balance.utxos, house.knockPrice + G.FEE_RESERVE);
      return G.runWithFeeProbe(provider, G.knockBuilder(provider, identity, key, house, door, inputs), onStatus);
    });
    if (result) {
      logTx(`knock on door ${door + 1}`, result.txId);
      await load(house.address);
      void refresh();
    }
  };

  const payout = async (door: number, method: "claim" | "claim_timeout") => {
    if (!provider || !identity || !house) return;
    const hex = myKeys[door];
    if (!hex) return;
    const d = house.doors[door];
    const amount = method === "claim" ? d.owed : house.knockPrice + house.bondPerDoor;
    const result = await action.run((onStatus) =>
      G.runWithFeeProbe(provider, G.payoutBuilder(provider, identity, G.keyFromHex(hex), house, method, door, amount), onStatus),
    );
    if (result) {
      logTx(method === "claim" ? `claim treat behind door ${door + 1}` : `refund for door ${door + 1}`, result.txId);
      await load(house.address);
      void refresh();
    }
  };

  return (
    <section className="card">
      <h2>Knock on a door</h2>
      <div className="row">
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="component_… address of a haunted house" />
        <button onClick={() => load(address)}>Enter</button>
      </div>
      {loadError && <p className="error">{loadError}</p>}
      {house && (
        <>
          <div className="row stats">
            <div>
              knock price <b>{tari(house.knockPrice)}</b> tXTR
            </div>
            <div>
              host bond <b>{tari(house.bondPerDoor)}</b> / door
            </div>
            <div>
              reveal window <b>{house.revealWindow.toString()}</b> epochs
            </div>
            <div>
              closes at epoch <b>{house.closeEpoch.toString()}</b>
            </div>
            <a href={G.substateUrl(house.address)} target="_blank" rel="noreferrer">explorer</a>
          </div>
          <p className="hint">
            The layout behind these doors was sealed before anyone knocked: only its Merkle root <code>{short(house.layoutRoot, 8, 6)}</code> is on chain. The host must open a door with a proof against that root or lose the bond.
          </p>
          <div className="doors">
            {house.doors.map((d, i) => {
              const mine = Boolean(myKeys[i]);
              const label = doorLabel(d, mine, epoch, house);
              const late = epoch !== null && d.prize === null && d.player !== null && BigInt(epoch) > d.knockedAt + house.revealWindow;
              return (
                <div key={i} className={`door ${label.cls} ${mine ? "mine" : ""}`}>
                  <div className="door-frame">
                    <div className="door-leaf">
                      <span className="door-number">{i + 1}</span>
                      <span className="knob" />
                    </div>
                  </div>
                  <div className="door-status">{label.text}</div>
                  {!d.player && !house.closed && (
                    <button className="primary" disabled={!identity || action.busy || balance.total < house.knockPrice + G.FEE_RESERVE} onClick={() => knock(i)}>
                      knock · {tari(house.knockPrice)} tXTR
                    </button>
                  )}
                  {mine && d.prize !== null && d.prize > 0n && !d.settled && (
                    <button className="primary" disabled={action.busy} onClick={() => payout(i, "claim")}>
                      claim {tari(d.owed)} tXTR
                    </button>
                  )}
                  {mine && late && (
                    <button className="primary" disabled={action.busy} onClick={() => payout(i, "claim_timeout")}>
                      take {tari(house.knockPrice + house.bondPerDoor)} tXTR back
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {!identity && <p className="hint">Create a wallet in the Wallet tab to knock.</p>}
          {identity && balance.total < house.knockPrice + G.FEE_RESERVE && <p className="hint">You need at least {tari(house.knockPrice + G.FEE_RESERVE)} tXTR (knock price plus fee reserve). Visit the faucet.</p>}
          {action.status && <p className="status">{action.status}…</p>}
          {action.error && <p className="error">{action.error}</p>}
        </>
      )}
    </section>
  );
}

function HostPanel({ provider, identity, store, update, balance, refresh, epoch, logTx }: Common) {
  const [doors, setDoors] = useState(4);
  const [prizes, setPrizes] = useState(["20", "0", "10", "0"]);
  const [price, setPrice] = useState("5");
  const [bond, setBond] = useState("2");
  const [window, setWindow] = useState("30");
  const [lifetime, setLifetime] = useState("600");
  const [selected, setSelected] = useState<string | null>(Object.keys(store.houses)[0] ?? null);
  const [house, setHouse] = useState<G.HouseState | null>(null);
  const [pool, setPool] = useState<bigint | null>(null);
  const action = useAction();

  const mine = Object.values(store.houses);
  const stored = selected ? store.houses[selected] : null;

  const loadHouse = useCallback(async (addr: string) => {
    const h = await G.fetchHouse(addr);
    setHouse(h);
    setPool(await G.fetchVaultBalance(h.vault));
  }, []);

  useEffect(() => {
    if (selected) loadHouse(selected).catch(() => setHouse(null));
  }, [selected, loadHouse]);

  const setDoorCount = (n: number) => {
    const count = Math.max(2, Math.min(8, n));
    setDoors(count);
    setPrizes((p) => Array.from({ length: count }, (_, i) => p[i] ?? "0"));
  };

  const open = async () => {
    if (!provider || !identity || epoch === null) return;
    const layout = { houseId: randomBytes(32), prizes: prizes.map(toMicro), salts: prizes.map(() => randomBytes(32)) };
    const params: G.HouseParams = {
      layout,
      knockPrice: toMicro(price),
      bondPerDoor: toMicro(bond),
      revealWindow: BigInt(window),
      closeEpoch: BigInt(epoch) + BigInt(lifetime),
    };
    const hostKey = G.freshKey();
    const funding = G.fundingFor(params);
    const result = await action.run(async (onStatus) => {
      onStatus("choosing coins");
      const inputs = O.pickInputs(balance.utxos, funding + G.FEE_RESERVE);
      return G.runWithFeeProbe(provider, G.openBuilder(provider, identity, hostKey, params, inputs), onStatus);
    });
    if (!result) return;
    const address = result.ups.find((u) => u.startsWith("component_"));
    if (!address) return;
    update((s) => ({
      ...s,
      houses: {
        ...s.houses,
        [address]: {
          address,
          hostKey: G.keyHex(hostKey),
          houseId: bytesToHex(layout.houseId),
          prizes: layout.prizes.map(String),
          salts: layout.salts.map(bytesToHex),
          openedTx: result.txId,
        },
      },
      lastHouse: address,
    }));
    logTx("open a haunted house", result.txId);
    setSelected(address);
    void refresh();
  };

  const hostAct = async (label: string, build: (inputs: O.OwnedUtxo[]) => G.Builder, needsCoins: boolean) => {
    if (!provider || !identity || !house) return;
    const result = await action.run(async (onStatus) => {
      const inputs = needsCoins ? O.pickInputs(balance.utxos, G.FEE_RESERVE) : [];
      return G.runWithFeeProbe(provider, build(inputs), onStatus);
    });
    if (result) {
      logTx(label, result.txId);
      await loadHouse(house.address);
      void refresh();
    }
  };

  const layoutOf = (s: typeof stored) => s && { houseId: hexToBytes(s.houseId), prizes: s.prizes.map(BigInt), salts: s.salts.map(hexToBytes) };

  return (
    <section className="card">
      <h2>Haunt a house</h2>
      <p className="hint">
        You decide what hides behind each door. The layout is hashed into a Merkle root and sealed on chain together with your bond - after that you cannot change your mind, and you must open every knocked door in time or pay the bond to the player.
      </p>
      <div className="form">
        <label>
          doors
          <input type="number" min={2} max={8} value={doors} onChange={(e) => setDoorCount(Number(e.target.value))} />
        </label>
        <label>
          knock price (tXTR)
          <input value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label>
          bond per door (tXTR)
          <input value={bond} onChange={(e) => setBond(e.target.value)} />
        </label>
        <label>
          reveal window (epochs)
          <input value={window} onChange={(e) => setWindow(e.target.value)} />
        </label>
        <label>
          open for (epochs)
          <input value={lifetime} onChange={(e) => setLifetime(e.target.value)} />
        </label>
      </div>
      <div className="prizes">
        {prizes.map((p, i) => (
          <label key={i}>
            door {i + 1}
            <input value={p} onChange={(e) => setPrizes(prizes.map((x, j) => (j === i ? e.target.value : x)))} />
            <span>{toMicro(p || "0") === 0n ? "trick" : "treat"}</span>
          </label>
        ))}
      </div>
      <div className="row">
        <span>
          funding needed: <b>{tari(prizes.reduce((n, p) => n + toMicro(p || "0"), 0n) + toMicro(bond || "0") * BigInt(doors))}</b> tXTR (prizes + bond)
        </span>
        <button className="primary" disabled={!identity || !provider || action.busy || epoch === null} onClick={open}>
          seal the layout and open the house
        </button>
      </div>

      {mine.length > 0 && (
        <>
          <h3>Your houses</h3>
          <div className="row">
            <select value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
              {mine.map((h) => (
                <option key={h.address} value={h.address}>
                  {short(h.address, 14, 6)}
                </option>
              ))}
            </select>
            {selected && (
              <>
                <button onClick={() => navigator.clipboard.writeText(selected)}>copy address</button>
                <a href={G.substateUrl(selected)} target="_blank" rel="noreferrer">explorer</a>
              </>
            )}
          </div>
          {house && stored && (
            <>
              <div className="row stats">
                <div>
                  pool <b>{pool === null ? "…" : tari(pool)}</b> tXTR
                </div>
                <div>
                  owed <b>{tari(house.owedTotal)}</b> tXTR
                </div>
                <div>{house.closed ? "closed" : `closes at epoch ${house.closeEpoch}`}</div>
              </div>
              <div className="doors small">
                {house.doors.map((d, i) => {
                  const label = doorLabel(d, false, epoch, house);
                  const prize = BigInt(stored.prizes[i]);
                  return (
                    <div key={i} className={`door ${label.cls}`}>
                      <div className="door-frame">
                        <div className="door-leaf">
                          <span className="door-number">{i + 1}</span>
                          <span className="knob" />
                        </div>
                      </div>
                      <div className="door-status">
                        {label.text} · hides {prize === 0n ? "a trick" : `${tari(prize)} tXTR`}
                      </div>
                      {d.player && d.prize === null && (
                        <button className="primary" disabled={action.busy} onClick={() => hostAct(`open door ${i + 1}`, (inputs) => G.revealBuilder(provider!, identity!, G.keyFromHex(stored.hostKey), house, layoutOf(stored)!, i, inputs), true)}>
                          open with proof
                        </button>
                      )}
                      {d.prize === 0n && !d.settled && (
                        <button disabled={action.busy} onClick={() => hostAct(`settle trick ${i + 1}`, (inputs) => G.settleBuilder(provider!, identity!, G.keyFromHex(stored.hostKey), house, i, inputs), true)}>
                          settle trick
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {!house.closed && pool !== null && (
                <div className="row">
                  <button disabled={action.busy} onClick={() => hostAct("close the house", () => G.payoutBuilder(provider!, identity!, G.keyFromHex(stored.hostKey), house, "close", null, G.closeAmount(house, pool)), false)}>
                    close and collect {tari(G.closeAmount(house, pool))} tXTR
                  </button>
                  <span className="hint">allowed once every door is knocked or the house expired, and all knocked doors are settled</span>
                </div>
              )}
            </>
          )}
        </>
      )}
      {action.status && <p className="status">{action.status}…</p>}
      {action.error && <p className="error">{action.error}</p>}
    </section>
  );
}

function TxLog({ txs }: { txs: TxEntry[] }) {
  if (txs.length === 0) return null;
  return (
    <section className="card log">
      <h3>Your transactions</h3>
      <ul>
        {txs.map((t) => (
          <li key={t.txId}>
            <span>{new Date(t.at).toLocaleTimeString()}</span> {t.label} ·{" "}
            <a href={G.txUrl(t.txId)} target="_blank" rel="noreferrer">
              {short(t.txId, 8, 6)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
