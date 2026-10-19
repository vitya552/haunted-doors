import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8 } from "../src/lib/bytes";
import { cborSignature } from "../src/lib/cbor";
import { knockMessage, layoutProof, layoutRoot } from "../src/lib/merkle";
import { challenge, publicKeyOf, scalarFromBytes, signWithNonce, verify } from "../src/lib/schnorr";

const expect = (name: string, got: string, want: string) => {
  console.log(`${got === want ? "ok  " : "FAIL"} ${name}`);
  if (got !== want) console.log(`  got  ${got}\n  want ${want}`);
};

const secret = scalarFromBytes(hexToBytes("aa544ca0cea842e836b410b8899357d764d90d07d6b1ce35dcf40959c57c3403"));
const nonce = scalarFromBytes(hexToBytes("79fcab8ca0ac9b70f0fe38ec818aa315b5561007c60eb931709a1cf6c471c50b"));
const pub = publicKeyOf(secret);
expect("public", bytesToHex(pub), "54ce9defe55c670c54fdbe71a16359aafc4953bb3ca2519e7f3abc7b974a1e05");
const message = knockMessage(new Uint8Array(32).fill(7), 3);
expect("message", bytesToHex(message), "05000000000000006b6e6f636b20000000000000000707070707070707070707070707070707070707070707070707070707070707010000000000000003");
const sig = signWithNonce(secret, nonce, message);
expect("nonce_public", bytesToHex(sig.publicNonce), "ca40a8360b23e7084d7df654e318c2ce6036c6e767eae787e9638e76176c1b1e");
expect("challenge", bytesToHex(challenge(message, pub, sig.publicNonce)), "d4167bafdfcb51a4e11c0ac74fcfc8ac874caf1161be89e82b3333e7fbd982950909e5d642ccfd1ddc594f007cc5d7cc4573ce899b5146edda26eaeee1cac58e");
expect("s", bytesToHex(sig.signature), "6e30ac4ee652bb3f18257ebaf879f9620e759cfb09ca3968eacb4ae076508903");
expect("verify", String(verify(sig, pub, message)), "true");
expect("cbor_signature", bytesToHex(cborSignature(sig)), "81820081825820ca40a8360b23e7084d7df654e318c2ce6036c6e767eae787e9638e76176c1b1e58206e30ac4ee652bb3f18257ebaf879f9620e759cfb09ca3968eacb4ae076508903");

const prizes = [500n, 0n, 200n, 0n];
const layout = {
  houseId: sha256(utf8("house manor")),
  prizes,
  salts: prizes.map((_, i) => sha256(utf8(`salt manor ${i}`))),
};
expect("house_id", bytesToHex(layout.houseId), "9f5fa9cdd7d2f8fb601889d3f166d66a9a640a90094b3ca5912fba20db919008");
expect("salt0", bytesToHex(layout.salts[0]), "296c8c3f7349f9fb50c5db63c493b1e440d1129528dda7320a8af0f77ad32c1a");
expect("root", bytesToHex(layoutRoot(layout)), "555f6a1538d8f20694d2259b9e18c6c597c460b0ef97d724002104e546dec127");
expect("proof0", layoutProof(layout, 0).map(bytesToHex).join(","), "d5c2eda2303a563d6113f2735d63b148f2e927a4b5a415f194adf3581e709ab9,9fc7702c9d47453cf7bc8509573ad564de7f5cd73cecee6e3e0cb442088410db");
