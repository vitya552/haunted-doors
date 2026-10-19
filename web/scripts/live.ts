import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { InstructionArg } from "@tari-project/ootle-ts-bindings";
import { loadOrCreate } from "./identity";
import * as O from "../src/lib/ootle";
import { arg } from "../src/lib/cbor";
import { knockMessage, layoutProof, layoutRoot, revealMessage } from "../src/lib/merkle";
import { publicKeyOf, randomScalar, scalarFromBytes, scalarToBytes, sign } from "../src/lib/schnorr";
import { bytesToHex, hexToBytes, randomBytes } from "../src/lib/bytes";

export const TEMPLATE = "template_2fcf98c66e524bba67311e6b4c21bf8b528103bccd5e19091fca840cba789563";
const STATE = ".local/game.json";
const T = O.MICRO;

interface GameState {
  hostKey?: string;
  houseId?: string;
  prizes?: string[];
  salts?: string[];
  house?: string;
  vault?: string;
  knockPrice?: string;
  bond?: string;
  doorKeys?: Record<string, string>;
  txs?: Record<string, string>;
}

const state: GameState = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const keyOf = (hex: string) => {
  const secret = scalarFromBytes(hexToBytes(hex));
  return { secret, bytes: scalarToBytes(secret), pub: publicKeyOf(secret) };
};
const houseBytes = () => hexToBytes(state.house!.replace("component_", ""));
const log = (...a: unknown[]) => console.log(...a);

async function run(provider: O.IndexerProvider, label: string, build: (dryRun: boolean, fee: bigint) => Promise<{ envelope: unknown }>) {
  const probe = await build(true, 2n * T);
  const dry = await O.dryRun(probe.envelope);
  const rejected = O.dryRunRejected(dry);
  if (rejected) throw new Error(`${label} dry-run rejected: ${rejected}`);
  const cost = O.dryRunCost(dry);
  const fee = (cost * 15n) / 10n + 1000n;
  log(`${label}: dry-run cost ${cost} µT, paying fee ${fee} µT`);
  const real = await build(false, fee);
  const pending = await O.submit(provider, real.envelope);
  const outcome = await pending.watch();
  log(`${label}: ${outcome.outcome}${"reason" in outcome && outcome.reason ? ` ${outcome.reason}` : ""}`);
  if (outcome.outcome !== "Commit") throw new Error(`${label} failed`);
  const receipt = await pending.getReceipt();
  const ups = O.upSubstates(receipt);
  const txId = ups.find((u) => u.startsWith("txreceipt_"))?.replace("txreceipt_", "") ?? "";
  state.txs = { ...state.txs, [label]: txId };
  save();
  return { ups, txId };
}

async function funds(provider: O.IndexerProvider, id: O.Identity, needed: bigint) {
  const owned = await O.filterUnspent(provider, await O.scanOwnedUtxos(id));
  return O.pickInputs(owned, needed);
}

const houseInputs = () => [
  { substate_id: state.house!, version: null },
  { substate_id: state.vault!, version: null },
  { substate_id: TEMPLATE, version: null },
];

async function main() {
  const [phase, a1, a2] = process.argv.slice(2);
  const provider = await O.connect();
  if (phase === "scan") {
    const id = loadOrCreate(a1);
    const owned = await O.scanOwnedUtxos(id, O.INDEXER_URL, (n) => log(`scanned ${n}`));
    const live = await O.filterUnspent(provider, owned);
    log(`${a1} ${id.ownerAddress}`);
    for (const u of live) log(`  ${u.id.slice(0, 16)}… ${u.value} µT`);
    log(`total ${live.reduce((n, u) => n + u.value, 0n)} µT`);
  } else if (phase === "open") {
    const host = loadOrCreate("host");
    const hostKey = state.hostKey ? keyOf(state.hostKey) : keyOf(bytesToHex(scalarToBytes(randomScalar())));
    const prizes = [20n * T, 0n, 10n * T, 0n];
    const salts = prizes.map(() => randomBytes(32));
    const houseId = randomBytes(32);
    const layout = { houseId, prizes, salts };
    const knockPrice = 5n * T;
    const bond = 2n * T;
    const funding = prizes.reduce((n, p) => n + p, 0n) + bond * BigInt(prizes.length);
    const closeEpoch = BigInt(await provider.getCurrentEpoch()) + 600n;
    Object.assign(state, {
      hostKey: bytesToHex(hostKey.bytes),
      houseId: bytesToHex(houseId),
      prizes: prizes.map(String),
      salts: salts.map(bytesToHex),
      knockPrice: String(knockPrice),
      bond: String(bond),
    });
    save();
    const inputs = await funds(provider, host, funding + 3n * T);
    const { ups } = await run(provider, "open", (dryRun, fee) =>
      O.buildFundedTransaction(provider, host, {
        inputs,
        revealed: funding,
        fee,
        dryRun,
        seal: O.sealFromScalar(hostKey.bytes, hostKey.pub),
        extraInputs: [{ substate_id: TEMPLATE, version: null }],
        instructions: (b, bucket) =>
          b.callFunction({ templateAddress: TEMPLATE, functionName: "open" }, [
            arg.bytes32(hostKey.pub),
            arg.bytes32(houseId),
            arg.u8(prizes.length),
            arg.bytes32(layoutRoot(layout)),
            arg.amount(knockPrice),
            arg.amount(bond),
            arg.u64(30n),
            arg.u64(closeEpoch),
            { Workspace: bucket } as InstructionArg,
          ]),
      }),
    );
    state.house = ups.find((u) => u.startsWith("component_"));
    state.vault = ups.find((u) => u.startsWith("vault_"));
    save();
    log(`house ${state.house} vault ${state.vault}`);
  } else if (phase === "knock") {
    const player = loadOrCreate("player");
    const door = Number(a1);
    const doorKey = keyOf(bytesToHex(scalarToBytes(randomScalar())));
    state.doorKeys = { ...state.doorKeys, [door]: bytesToHex(doorKey.bytes) };
    save();
    const sig = sign(doorKey.secret, knockMessage(houseBytes(), door));
    const price = BigInt(state.knockPrice!);
    const inputs = await funds(provider, player, price + 3n * T);
    await run(provider, `knock-${door}`, (dryRun, fee) =>
      O.buildFundedTransaction(provider, player, {
        inputs,
        revealed: price,
        fee,
        dryRun,
        seal: O.sealFromScalar(doorKey.bytes, doorKey.pub),
        extraInputs: houseInputs(),
        instructions: (b, bucket) =>
          b.callMethod({ componentAddress: state.house!, methodName: "knock" }, [
            arg.bytes32(doorKey.pub),
            arg.u8(door),
            arg.signature(sig),
            { Workspace: bucket } as InstructionArg,
          ]),
      }),
    );
  } else if (phase === "reveal") {
    const host = loadOrCreate("host");
    const hostKey = keyOf(state.hostKey!);
    const door = Number(a1);
    const layout = { houseId: hexToBytes(state.houseId!), prizes: state.prizes!.map(BigInt), salts: state.salts!.map(hexToBytes) };
    const prize = layout.prizes[door];
    const salt = layout.salts[door];
    const sig = sign(hostKey.secret, revealMessage(houseBytes(), door, prize, salt));
    const inputs = await funds(provider, host, 3n * T);
    await run(provider, `reveal-${door}`, (dryRun, fee) =>
      O.buildFundedTransaction(provider, host, {
        inputs,
        revealed: 0n,
        fee,
        dryRun,
        seal: O.sealFromScalar(hostKey.bytes, hostKey.pub),
        extraInputs: houseInputs(),
        instructions: (b) =>
          b.callMethod({ componentAddress: state.house!, methodName: "reveal" }, [
            arg.u8(door),
            arg.amount(prize),
            arg.bytes32(salt),
            arg.hashes(layoutProof(layout, door)),
            arg.signature(sig),
          ]),
      }),
    );
  } else if (phase === "claim" || phase === "timeout") {
    const player = loadOrCreate("player");
    const door = Number(a1);
    const doorKey = keyOf(state.doorKeys![door]);
    const amount = phase === "claim" ? BigInt(state.prizes![door]) : BigInt(state.knockPrice!) + BigInt(state.bond!);
    await run(provider, `${phase}-${door}`, (dryRun, fee) =>
      O.buildPayoutTransaction(provider, player, {
        house: state.house!,
        method: phase === "claim" ? "claim" : "claim_timeout",
        args: [arg.u8(door)],
        amount,
        fee,
        dryRun,
        seal: O.sealFromScalar(doorKey.bytes, doorKey.pub),
        extraInputs: houseInputs().slice(1),
      }),
    );
  } else if (phase === "close") {
    const host = loadOrCreate("host");
    const hostKey = keyOf(state.hostKey!);
    const amount = BigInt(a1);
    await run(provider, "close", (dryRun, fee) =>
      O.buildPayoutTransaction(provider, host, {
        house: state.house!,
        method: "close",
        args: [],
        amount,
        fee,
        dryRun,
        seal: O.sealFromScalar(hostKey.bytes, hostKey.pub),
        extraInputs: houseInputs().slice(1),
      }),
    );
  } else if (phase === "settle") {
    const host = loadOrCreate("host");
    const hostKey = keyOf(state.hostKey!);
    const door = Number(a1);
    const inputs = await funds(provider, host, 3n * T);
    await run(provider, `settle-${door}`, (dryRun, fee) =>
      O.buildFundedTransaction(provider, host, {
        inputs,
        revealed: 0n,
        fee,
        dryRun,
        seal: O.sealFromScalar(hostKey.bytes, hostKey.pub),
        extraInputs: houseInputs(),
        instructions: (b) => b.callMethod({ componentAddress: state.house!, methodName: "settle_trick" }, [arg.u8(door)]),
      }),
    );
  } else {
    log("usage: live.ts scan <name> | open | knock <door> | reveal <door> | claim <door> | timeout <door> | settle <door> | close <amount>");
  }
  void a2;
  provider.stopWatcher();
}

process.on("unhandledRejection", (reason) => {
  if (reason && typeof reason === "object" && (reason as { name?: string }).name === "AbortError") return;
  console.error(reason);
  process.exit(1);
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
