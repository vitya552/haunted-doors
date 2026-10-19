import { bytesToHex, concat } from "./bytes";
import type { DoorsSignature } from "./schnorr";

function head(major: number, n: bigint | number): Uint8Array {
  const v = BigInt(n);
  const m = major << 5;
  if (v < 24n) return Uint8Array.of(m | Number(v));
  if (v < 0x100n) return Uint8Array.of(m | 24, Number(v));
  if (v < 0x10000n) return Uint8Array.of(m | 25, Number(v >> 8n), Number(v & 0xffn));
  if (v < 0x100000000n) {
    return Uint8Array.of(m | 26, Number(v >> 24n), Number((v >> 16n) & 0xffn), Number((v >> 8n) & 0xffn), Number(v & 0xffn));
  }
  if (v < 0x10000000000000000n) {
    const out = new Uint8Array(9);
    out[0] = m | 27;
    let x = v;
    for (let i = 8; i >= 1; i--) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return out;
  }
  throw new Error("value does not fit a CBOR u64");
}

export function cborUint(n: bigint | number): Uint8Array {
  return head(0, n);
}

export function cborBytes(bytes: Uint8Array): Uint8Array {
  return concat(head(2, bytes.length), bytes);
}

export function cborArray(items: Uint8Array[]): Uint8Array {
  return concat(head(4, items.length), ...items);
}

export function cborSignature(sig: DoorsSignature): Uint8Array {
  return cborArray([cborArray([cborUint(0), cborArray([cborArray([cborBytes(sig.publicNonce), cborBytes(sig.signature)])])])]);
}

export function literal(encoded: Uint8Array): { Literal: string } {
  return { Literal: bytesToHex(encoded) };
}

export const arg = {
  u8: (n: number) => literal(cborUint(n)),
  u64: (n: bigint | number) => literal(cborUint(n)),
  amount: (n: bigint) => literal(cborUint(n)),
  bytes32: (b: Uint8Array) => literal(cborBytes(b)),
  hashes: (hs: Uint8Array[]) => literal(cborArray(hs.map(cborBytes))),
  signature: (sig: DoorsSignature) => literal(cborSignature(sig)),
};
