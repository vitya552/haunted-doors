import {
  Mask,
  Network,
  StealthInput,
  StealthTransferStatement,
  TransactionBuilder,
  TARI_RESOURCE_ADDRESS,
  WasmStealthCrypto,
  createOutput,
  decryptInputData,
  defaultIndexerUrl,
  resolveMaxEpoch,
  resolveTransaction,
  sealTransaction,
  serializeUnsignedTx,
  signBalanceProof,
  signTransaction,
  stealthTransferInstruction,
  stealthUtxoSubstateId,
  type Signer,
} from "@tari-project/ootle";
import type {
  ComponentAddress,
  Instruction,
  InstructionArg,
  TransactionSignature,
  WorkspaceOffsetId,
} from "@tari-project/ootle-ts-bindings";
import { IndexerProvider, type PendingTransaction } from "@tari-project/ootle-indexer";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { generateOotleAddress, generateOotleSecretKey, ootlePublicKeyFromSecretKey } from "@tari-project/ootle-wasm";
import { bytesToHex, hexToBytes } from "./bytes";

export const NETWORK = Network.Esmeralda;
export type { IndexerProvider } from "@tari-project/ootle-indexer";
export const TARI = TARI_RESOURCE_ADDRESS;
export const INDEXER_URL = defaultIndexerUrl(NETWORK);
export const MICRO = 1_000_000n;

export interface Identity {
  secret: SecretKeyWallet;
  ownerAddress: string;
  ownerSecret: Uint8Array;
  ownerPublicKey: Uint8Array;
  viewSecret: Uint8Array;
}

export function identityFromKeys(ownerSecret: Uint8Array, viewSecret: Uint8Array): Identity {
  const pk = ootlePublicKeyFromSecretKey(ownerSecret, viewSecret);
  const secret = SecretKeyWallet.fromKeypair(ownerSecret, pk.owner_key, NETWORK, viewSecret);
  const ownerAddress = generateOotleAddress(pk.owner_key, pk.view_key, NETWORK);
  return { secret, ownerAddress, ownerSecret, ownerPublicKey: pk.owner_key, viewSecret };
}

export function newIdentity(): Identity {
  const sk = generateOotleSecretKey();
  return identityFromKeys(sk.owner_key, sk.view_key);
}

export function exportIdentity(id: Identity): string {
  return `${bytesToHex(id.ownerSecret)}:${bytesToHex(id.viewSecret)}`;
}

export function importIdentity(encoded: string): Identity {
  const [owner, view] = encoded.split(":");
  return identityFromKeys(hexToBytes(owner), hexToBytes(view));
}

export async function connect(url: string = INDEXER_URL): Promise<IndexerProvider> {
  return IndexerProvider.connect({ url, network: NETWORK });
}

export function stealthCrypto(): WasmStealthCrypto {
  return new WasmStealthCrypto(NETWORK);
}

export interface OwnedUtxo {
  id: string;
  commitment: Uint8Array;
  publicNonce: Uint8Array;
  value: bigint;
  mask: Mask;
}

interface IndexerUtxoRow {
  output: { output: { public_nonce: string; encrypted_data: string } } | null;
  is_frozen: boolean;
}

async function indexerGet<T>(url: string, path: string): Promise<T> {
  const response = await fetch(`${url.replace(/\/$/, "")}/${path}`);
  if (!response.ok) throw new Error(`indexer ${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function scanOwnedUtxos(
  identity: Identity,
  url: string = INDEXER_URL,
  onProgress?: (scanned: number) => void,
): Promise<OwnedUtxo[]> {
  const crypto = stealthCrypto();
  const owned: OwnedUtxo[] = [];
  let from: string | null = null;
  let scanned = 0;
  for (;;) {
    const query: string = `utxos?resource_address=${TARI}&limit=1000${from ? `&from_id=${from}` : ""}`;
    const page: { utxos: Array<[string, IndexerUtxoRow]> } = await indexerGet(url, query);
    for (const [id, row] of page.utxos) {
      scanned += 1;
      if (row.is_frozen || row.output === null) continue;
      const commitment = hexToBytes(id);
      const publicNonce = hexToBytes(row.output.output.public_nonce);
      try {
        const data = await decryptInputData(crypto, commitment, hexToBytes(row.output.output.encrypted_data), {
          senderPublicNonce: publicNonce,
          viewSecret: identity.viewSecret,
          skipMemo: true,
        });
        owned.push({ id, commitment, publicNonce, value: data.value, mask: data.mask });
      } catch {
        continue;
      }
    }
    onProgress?.(scanned);
    if (page.utxos.length < 1000) break;
    from = page.utxos[page.utxos.length - 1][0];
  }
  return owned;
}

export async function filterUnspent(provider: IndexerProvider, utxos: OwnedUtxo[]): Promise<OwnedUtxo[]> {
  const live: OwnedUtxo[] = [];
  for (const utxo of utxos) {
    const substate = await provider.getStealthUtxo(TARI, utxo.commitment);
    if (substate !== null) live.push(utxo);
  }
  return live;
}

export function pickInputs(utxos: OwnedUtxo[], needed: bigint): OwnedUtxo[] {
  const sorted = [...utxos].sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  const picked: OwnedUtxo[] = [];
  let total = 0n;
  for (const utxo of sorted) {
    if (total > needed) break;
    picked.push(utxo);
    total += utxo.value;
  }
  if (total <= needed) throw new Error(`not enough funds: have ${total}, need more than ${needed}`);
  return picked;
}

class StaticSignatures implements Signer {
  constructor(private readonly signatures: TransactionSignature[]) {}
  async getAddress(): Promise<string> {
    throw new Error("static signatures have no address");
  }
  async getPublicKey(): Promise<Uint8Array> {
    throw new Error("static signatures have no public key");
  }
  async signTransaction(): Promise<TransactionSignature[]> {
    return this.signatures;
  }
}

export interface SealKey {
  secret_key: Uint8Array;
  public_key: Uint8Array;
}

export interface SubstateRef {
  substate_id: string;
  version: number | null;
}

export interface FundedCall {
  inputs: OwnedUtxo[];
  revealed: bigint;
  fee: bigint;
  seal: SealKey;
  extraInputs?: SubstateRef[];
  dryRun?: boolean;
  instructions: (b: TransactionBuilder, funds: WorkspaceOffsetId) => void;
}

export async function buildFundedTransaction(provider: IndexerProvider, identity: Identity, call: FundedCall) {
  const total = call.inputs.reduce((n, u) => n + u.value, 0n);
  const change = total - call.revealed - call.fee;
  if (change <= 0n) throw new Error("inputs must leave positive change");
  const crypto = stealthCrypto();
  const { statement: outputsStatement, outputMask } = await crypto.generateOutputsStatement(
    [createOutput({ destination: identity.ownerAddress, amount: change, resourceAddress: TARI })],
    { amount: call.revealed + call.fee, receiver: call.seal.public_key },
  );
  const inputsStatement = await crypto.buildInputsStatement(
    call.inputs.map((u) => new StealthInput(u.commitment)),
    0n,
  );
  const inputMask = await crypto.aggregateInputMasks(call.inputs.map((u) => u.mask));
  const balanceProof = await signBalanceProof(crypto, inputMask, outputMask, inputsStatement, outputsStatement);
  const statement = new StealthTransferStatement(inputsStatement, outputsStatement, balanceProof);
  await crypto.validateTransfer(statement);

  const builder = new TransactionBuilder(NETWORK, await resolveMaxEpoch(provider)).withFeeInstructionsBuilder((b) => {
    b.addInstruction(
      stealthTransferInstruction({ resourceAddress: TARI, revealedInputBucket: null, statement }, (name) =>
        b.resolveWorkspaceOffsetId(name),
      ),
    ).saveVar("funds");
    const funds = b.resolveWorkspaceOffsetId("funds");
    if (call.revealed === 0n) {
      b.addInstruction({ PayFeeFromBucket: { bucket: funds } });
    } else {
      const feeBucket = funds.id + 1;
      b.addInstruction({ TakeFromBucket: { input_bucket: funds, amount: Number(call.fee), output_bucket: feeBucket } });
      b.addInstruction({ PayFeeFromBucket: { bucket: { id: feeBucket, offset: null } } });
    }
    call.instructions(b, funds);
    return b;
  });
  builder.withInputs([
    ...call.inputs.map((u) => ({ substate_id: stealthUtxoSubstateId(TARI, u.commitment), version: null })),
    ...(call.extraInputs ?? []),
  ]);
  const unsigned = { ...(await resolveTransaction(provider, builder.buildUnsignedTransaction())), dry_run: call.dryRun ?? false, is_seal_signer_authorized: true };
  const unsignedJson = serializeUnsignedTx(unsigned);
  const signatures: TransactionSignature[] = [];
  for (const utxo of call.inputs) {
    signatures.push(await identity.secret.addStealthSignature(unsignedJson, utxo.publicNonce, call.seal.public_key, { crypto }));
  }
  const signed = await signTransaction([new StaticSignatures(signatures)], unsigned, call.seal);
  return { unsigned, envelope: sealTransaction(signed) };
}

export interface PayoutCall {
  house: ComponentAddress;
  method: string;
  args: InstructionArg[];
  amount: bigint;
  fee: bigint;
  seal: SealKey;
  extraInputs?: SubstateRef[];
  dryRun?: boolean;
}

export async function buildPayoutTransaction(provider: IndexerProvider, identity: Identity, call: PayoutCall) {
  const toStealth = call.amount - call.fee;
  if (toStealth <= 0n) throw new Error("payout must exceed the fee");
  const crypto = stealthCrypto();
  const { statement: outputsStatement, outputMask } = await crypto.generateOutputsStatement(
    [createOutput({ destination: identity.ownerAddress, amount: toStealth, resourceAddress: TARI })],
    { amount: call.fee, receiver: call.seal.public_key },
  );
  const inputsStatement = await crypto.buildInputsStatement([], call.amount);
  const balanceProof = await signBalanceProof(crypto, Mask.zero(), outputMask, inputsStatement, outputsStatement);
  const statement = new StealthTransferStatement(inputsStatement, outputsStatement, balanceProof);
  await crypto.validateTransfer(statement);

  const builder = new TransactionBuilder(NETWORK, await resolveMaxEpoch(provider)).withFeeInstructionsBuilder((b) =>
    b
      .callMethod({ componentAddress: call.house, methodName: call.method }, call.args)
      .saveVar("payout")
      .addInstruction(
        stealthTransferInstruction({ resourceAddress: TARI, revealedInputBucket: "payout", statement }, (name) =>
          b.resolveWorkspaceOffsetId(name),
        ),
      )
      .saveVar("fee")
      .addInstruction({ PayFeeFromBucket: { bucket: b.resolveWorkspaceOffsetId("fee") } }),
  );
  builder.withInputs([{ substate_id: call.house, version: null }, ...(call.extraInputs ?? [])]);
  const unsigned = { ...(await resolveTransaction(provider, builder.buildUnsignedTransaction())), dry_run: call.dryRun ?? false, is_seal_signer_authorized: true };
  const signed = await signTransaction([], unsigned, call.seal);
  return { unsigned, envelope: sealTransaction(signed) };
}

export async function dryRun(envelope: unknown, url: string = INDEXER_URL) {
  const response = await fetch(`${url.replace(/\/$/, "")}/transactions/dry-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: envelope }),
  });
  if (!response.ok) throw new Error(`dry-run: HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<DryRunResult>;
}

export interface DryRunResult {
  transaction_id: string;
  result: {
    finalize: {
      result: { Accept: unknown } | { AcceptFeeRejectRest: [unknown, unknown] } | { Reject: unknown };
      fee_receipt?: { total_fees_paid: number; cost_breakdown?: { breakdown: Record<string, number> } };
      cost_breakdown?: { breakdown: Record<string, number> };
      logs?: unknown[];
    };
  };
}

export function dryRunCost(result: DryRunResult): bigint {
  const breakdown = result.result.finalize.cost_breakdown?.breakdown ?? result.result.finalize.fee_receipt?.cost_breakdown?.breakdown ?? {};
  return BigInt(Object.values(breakdown).reduce((a, b) => a + b, 0));
}

export function dryRunRejected(result: DryRunResult): string | null {
  const inner = result.result.finalize.result;
  if ("Accept" in inner) return null;
  if ("Reject" in inner) return JSON.stringify(inner.Reject);
  return JSON.stringify(inner.AcceptFeeRejectRest[1]);
}

export async function submit(provider: IndexerProvider, envelope: unknown): Promise<PendingTransaction> {
  const { transaction_id } = await provider.submitTransaction(envelope as never);
  return provider.watchTransactionSSE(transaction_id);
}

export function upSubstates(receipt: unknown): string[] {
  const r = receipt as { result?: { Finalized?: { execution_result?: { finalize?: { result?: { Accept?: { up_substates: Array<[string, unknown]> } } } } } } };
  const diff = r.result?.Finalized?.execution_result?.finalize?.result?.Accept;
  return diff ? diff.up_substates.map(([id]) => id) : [];
}

export function instructionsFor(b: TransactionBuilder, list: Instruction[]): TransactionBuilder {
  for (const i of list) b.addInstruction(i);
  return b;
}

export function sealFromScalar(secret: Uint8Array, publicKey: Uint8Array): SealKey {
  return { secret_key: secret, public_key: publicKey };
}
