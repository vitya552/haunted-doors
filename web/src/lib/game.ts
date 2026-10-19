import type { InstructionArg } from "@tari-project/ootle-ts-bindings";
import * as O from "./ootle";
import { arg } from "./cbor";
import { knockMessage, layoutProof, layoutRoot, revealMessage, type Layout } from "./merkle";
import { publicKeyOf, scalarFromBytes, scalarToBytes, sign, randomScalar } from "./schnorr";
import { bytesToHex, hexToBytes } from "./bytes";

export const TEMPLATE = "template_2fcf98c66e524bba67311e6b4c21bf8b528103bccd5e19091fca840cba789563";
export const EXPLORER = "https://taritracker.com/ootle/esmeralda";
export const FEE_PROBE = 2n * O.MICRO;
export const FEE_RESERVE = 3n * O.MICRO;

export interface OneTimeKey {
  secret: bigint;
  bytes: Uint8Array;
  pub: Uint8Array;
}

export function keyFromHex(hex: string): OneTimeKey {
  const secret = scalarFromBytes(hexToBytes(hex));
  return { secret, bytes: scalarToBytes(secret), pub: publicKeyOf(secret) };
}

export function freshKey(): OneTimeKey {
  return keyFromHex(bytesToHex(scalarToBytes(randomScalar())));
}

export const keyHex = (k: OneTimeKey) => bytesToHex(k.bytes);
export const houseBytes = (house: string) => hexToBytes(house.replace("component_", ""));
export const sealOf = (k: OneTimeKey) => O.sealFromScalar(k.bytes, k.pub);

export interface HouseParams {
  layout: Layout;
  knockPrice: bigint;
  bondPerDoor: bigint;
  revealWindow: bigint;
  closeEpoch: bigint;
}

export function fundingFor(p: HouseParams): bigint {
  return p.layout.prizes.reduce((n, x) => n + x, 0n) + p.bondPerDoor * BigInt(p.layout.prizes.length);
}

export interface DoorState {
  player: string | null;
  knockedAt: bigint;
  prize: bigint | null;
  owed: bigint;
  settled: boolean;
}

export interface HouseState {
  address: string;
  version: number;
  hostKey: string;
  houseId: string;
  layoutRoot: string;
  knockPrice: bigint;
  bondPerDoor: bigint;
  revealWindow: bigint;
  closeEpoch: bigint;
  doors: DoorState[];
  vault: string;
  owedTotal: bigint;
  closed: boolean;
}

type CborBytes = { "@cbor": "bytes"; hex: string };
type CborTag = { "@cbor": "tag"; tag: number; value: CborBytes };

export async function fetchHouse(address: string, url: string = O.INDEXER_URL): Promise<HouseState> {
  const response = await fetch(`${url.replace(/\/$/, "")}/substates/${address}`);
  if (!response.ok) throw new Error(`house ${address}: HTTP ${response.status}`);
  const json = (await response.json()) as { version: number; substate: { Component: { header: { template_address: string }; body: { state: unknown[] } } } };
  const component = json.substate.Component;
  if (!component) throw new Error("not a component");
  if (component.header.template_address !== TEMPLATE.replace("template_", "")) throw new Error("not a Haunted Doors house");
  const s = component.body.state;
  const b = (v: unknown) => (v as CborBytes).hex;
  const n = (v: unknown) => BigInt(v as number | string);
  const doors = (s[7] as unknown[][]).map((d) => ({
    player: d[0] === null ? null : b(d[0]),
    knockedAt: n(d[1]),
    prize: d[2] === null ? null : n(d[2]),
    owed: n(d[3]),
    settled: Boolean(d[4]),
  }));
  return {
    address,
    version: json.version,
    hostKey: b(s[0]),
    houseId: b(s[1]),
    layoutRoot: b(s[2]),
    knockPrice: n(s[3]),
    bondPerDoor: n(s[4]),
    revealWindow: n(s[5]),
    closeEpoch: n(s[6]),
    doors,
    vault: `vault_${(s[8] as CborTag).value.hex}`,
    owedTotal: n(s[9]),
    closed: Boolean(s[10]),
  };
}

export const houseInputs = (house: HouseState) => [
  { substate_id: house.address, version: null },
  { substate_id: house.vault, version: null },
  { substate_id: TEMPLATE, version: null },
];

export type Builder = (dryRun: boolean, fee: bigint) => Promise<{ envelope: unknown }>;

export interface RunResult {
  txId: string;
  ups: string[];
  cost: bigint;
  fee: bigint;
}

export async function runWithFeeProbe(
  provider: O.IndexerProvider,
  build: Builder,
  onStatus?: (s: string) => void,
): Promise<RunResult> {
  onStatus?.("estimating fee");
  const dry = await O.dryRun((await build(true, FEE_PROBE)).envelope);
  const rejected = O.dryRunRejected(dry);
  if (rejected) throw new Error(`rejected: ${rejected}`);
  const cost = O.dryRunCost(dry);
  const fee = (cost * 15n) / 10n + 1000n;
  onStatus?.(`submitting (fee ${Number(fee) / 1e6} tXTR)`);
  const pending = await O.submit(provider, (await build(false, fee)).envelope);
  onStatus?.("waiting for the chain");
  const outcome = await pending.watch();
  if (outcome.outcome !== "Commit") throw new Error(`${outcome.outcome}: ${"reason" in outcome ? outcome.reason : ""}`);
  const ups = O.upSubstates(await pending.getReceipt());
  const txId = ups.find((u) => u.startsWith("txreceipt_"))?.replace("txreceipt_", "") ?? "";
  return { txId, ups, cost, fee };
}

export async function spendable(provider: O.IndexerProvider, id: O.Identity, needed: bigint, onProgress?: (n: number) => void) {
  const owned = await O.filterUnspent(provider, await O.scanOwnedUtxos(id, O.INDEXER_URL, onProgress));
  return O.pickInputs(owned, needed);
}

export function openBuilder(provider: O.IndexerProvider, host: O.Identity, hostKey: OneTimeKey, p: HouseParams, inputs: O.OwnedUtxo[]): Builder {
  const funding = fundingFor(p);
  return (dryRun, fee) =>
    O.buildFundedTransaction(provider, host, {
      inputs,
      revealed: funding,
      fee,
      dryRun,
      seal: sealOf(hostKey),
      extraInputs: [{ substate_id: TEMPLATE, version: null }],
      instructions: (b, bucket) =>
        b.callFunction({ templateAddress: TEMPLATE, functionName: "open" }, [
          arg.bytes32(hostKey.pub),
          arg.bytes32(p.layout.houseId),
          arg.u8(p.layout.prizes.length),
          arg.bytes32(layoutRoot(p.layout)),
          arg.amount(p.knockPrice),
          arg.amount(p.bondPerDoor),
          arg.u64(p.revealWindow),
          arg.u64(p.closeEpoch),
          { Workspace: bucket } as InstructionArg,
        ]),
    });
}

export function knockBuilder(provider: O.IndexerProvider, player: O.Identity, doorKey: OneTimeKey, house: HouseState, door: number, inputs: O.OwnedUtxo[]): Builder {
  const sig = sign(doorKey.secret, knockMessage(houseBytes(house.address), door));
  return (dryRun, fee) =>
    O.buildFundedTransaction(provider, player, {
      inputs,
      revealed: house.knockPrice,
      fee,
      dryRun,
      seal: sealOf(doorKey),
      extraInputs: houseInputs(house),
      instructions: (b, bucket) =>
        b.callMethod({ componentAddress: house.address, methodName: "knock" }, [
          arg.bytes32(doorKey.pub),
          arg.u8(door),
          arg.signature(sig),
          { Workspace: bucket } as InstructionArg,
        ]),
    });
}

export function revealBuilder(provider: O.IndexerProvider, host: O.Identity, hostKey: OneTimeKey, house: HouseState, layout: Layout, door: number, inputs: O.OwnedUtxo[]): Builder {
  const prize = layout.prizes[door];
  const salt = layout.salts[door];
  const sig = sign(hostKey.secret, revealMessage(houseBytes(house.address), door, prize, salt));
  return (dryRun, fee) =>
    O.buildFundedTransaction(provider, host, {
      inputs,
      revealed: 0n,
      fee,
      dryRun,
      seal: sealOf(hostKey),
      extraInputs: houseInputs(house),
      instructions: (b) =>
        b.callMethod({ componentAddress: house.address, methodName: "reveal" }, [
          arg.u8(door),
          arg.amount(prize),
          arg.bytes32(salt),
          arg.hashes(layoutProof(layout, door)),
          arg.signature(sig),
        ]),
    });
}

export function settleBuilder(provider: O.IndexerProvider, id: O.Identity, key: OneTimeKey, house: HouseState, door: number, inputs: O.OwnedUtxo[]): Builder {
  return (dryRun, fee) =>
    O.buildFundedTransaction(provider, id, {
      inputs,
      revealed: 0n,
      fee,
      dryRun,
      seal: sealOf(key),
      extraInputs: houseInputs(house),
      instructions: (b) => b.callMethod({ componentAddress: house.address, methodName: "settle_trick" }, [arg.u8(door)]),
    });
}

export function payoutBuilder(
  provider: O.IndexerProvider,
  id: O.Identity,
  key: OneTimeKey,
  house: HouseState,
  method: "claim" | "claim_timeout" | "close",
  door: number | null,
  amount: bigint,
): Builder {
  return (dryRun, fee) =>
    O.buildPayoutTransaction(provider, id, {
      house: house.address,
      method,
      args: door === null ? [] : [arg.u8(door)],
      amount,
      fee,
      dryRun,
      seal: sealOf(key),
      extraInputs: houseInputs(house).slice(1),
    });
}

export function closeAmount(house: HouseState, poolBalance: bigint): bigint {
  return poolBalance - house.owedTotal;
}

export const txUrl = (txId: string) => `${EXPLORER}/transactions/${txId}`;
export const substateUrl = (id: string) => `${EXPLORER}/substates/${id}`;

export async function fetchVaultBalance(vault: string, url: string = O.INDEXER_URL): Promise<bigint> {
  const response = await fetch(`${url.replace(/\/$/, "")}/substates/${vault}`);
  if (!response.ok) throw new Error(`vault ${vault}: HTTP ${response.status}`);
  const json = (await response.json()) as { substate: { Vault: { resource_container: Record<string, unknown> } } };
  const container = json.substate.Vault.resource_container;
  const found = JSON.stringify(container).match(/"revealed_amount":"?(\d+)"?/) ?? JSON.stringify(container).match(/"amount":"?(\d+)"?/);
  return found ? BigInt(found[1]) : 0n;
}
