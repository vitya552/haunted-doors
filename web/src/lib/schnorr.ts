import { RistrettoPoint, ed25519 } from "@noble/curves/ed25519";
import { bytesToNumberLE, numberToBytesLE } from "@noble/curves/utils";
import { mod } from "@noble/curves/abstract/modular";
import { blake2b } from "@noble/hashes/blake2b";
import { concat, randomBytes, utf8 } from "./bytes";

export const SIGNATURE_DOMAIN = utf8("haunted-doors/sig/v1");

const ORDER = ed25519.CURVE.n;

export interface DoorsSignature {
  publicNonce: Uint8Array;
  signature: Uint8Array;
}

export function scalarFromWide(bytes64: Uint8Array): bigint {
  return mod(bytesToNumberLE(bytes64), ORDER);
}

export function randomScalar(): bigint {
  return scalarFromWide(randomBytes(64));
}

export function scalarToBytes(s: bigint): Uint8Array {
  return numberToBytesLE(s, 32);
}

export function scalarFromBytes(bytes32: Uint8Array): bigint {
  return mod(bytesToNumberLE(bytes32), ORDER);
}

export function publicKeyOf(secret: bigint): Uint8Array {
  return RistrettoPoint.BASE.multiply(secret).toRawBytes();
}

export function challenge(message: Uint8Array, publicKey: Uint8Array, publicNonce: Uint8Array): Uint8Array {
  return blake2b(concat(SIGNATURE_DOMAIN, publicNonce, publicKey, message), { dkLen: 64 });
}

export function signWithNonce(secret: bigint, nonce: bigint, message: Uint8Array): DoorsSignature {
  const publicKey = publicKeyOf(secret);
  const publicNonce = publicKeyOf(nonce);
  const e = scalarFromWide(challenge(message, publicKey, publicNonce));
  const s = mod(nonce + e * secret, ORDER);
  return { publicNonce, signature: scalarToBytes(s) };
}

export function sign(secret: bigint, message: Uint8Array): DoorsSignature {
  return signWithNonce(secret, randomScalar(), message);
}

export function verify(sig: DoorsSignature, publicKey: Uint8Array, message: Uint8Array): boolean {
  const e = scalarFromWide(challenge(message, publicKey, sig.publicNonce));
  const lhs = RistrettoPoint.BASE.multiply(scalarFromBytes(sig.signature));
  const rhs = RistrettoPoint.fromHex(sig.publicNonce).add(RistrettoPoint.fromHex(publicKey).multiply(e));
  return lhs.equals(rhs);
}
