import { sha256 } from "@noble/hashes/sha2";
import { concat, lenPrefixed, u128le, utf8 } from "./bytes";

const DOMAIN_LEAF = lenPrefixed(utf8("haunted-doors/leaf/v1"));
const DOMAIN_NODE = lenPrefixed(utf8("haunted-doors/node/v1"));

export const MSG_KNOCK = utf8("knock");
export const MSG_REVEAL = utf8("reveal");

export function doorLeaf(houseId: Uint8Array, door: number, prize: bigint, salt: Uint8Array): Uint8Array {
  return sha256(concat(DOMAIN_LEAF, houseId, Uint8Array.of(door), u128le(prize), salt));
}

export function merkleNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concat(DOMAIN_NODE, left, right));
}

export interface Layout {
  houseId: Uint8Array;
  prizes: bigint[];
  salts: Uint8Array[];
}

function levels(layout: Layout): Uint8Array[][] {
  let level = layout.prizes.map((prize, i) => doorLeaf(layout.houseId, i, prize, layout.salts[i]));
  const all = [level];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(merkleNode(left, right));
    }
    level = next;
    all.push(level);
  }
  return all;
}

export function layoutRoot(layout: Layout): Uint8Array {
  const all = levels(layout);
  return all[all.length - 1][0];
}

export function layoutProof(layout: Layout, door: number): Uint8Array[] {
  const proof: Uint8Array[] = [];
  let index = door;
  for (const level of levels(layout)) {
    if (level.length === 1) break;
    const sibling = index ^ 1;
    if (index % 2 === 1 || sibling < level.length) proof.push(level[sibling]);
    index = Math.floor(index / 2);
  }
  return proof;
}

export function actionMessage(action: Uint8Array, house: Uint8Array, payload: Uint8Array[]): Uint8Array {
  return concat(lenPrefixed(action), lenPrefixed(house), ...payload.map(lenPrefixed));
}

export function knockMessage(house: Uint8Array, door: number): Uint8Array {
  return actionMessage(MSG_KNOCK, house, [Uint8Array.of(door)]);
}

export function revealMessage(house: Uint8Array, door: number, prize: bigint, salt: Uint8Array): Uint8Array {
  return actionMessage(MSG_REVEAL, house, [Uint8Array.of(door), u128le(prize), salt]);
}
