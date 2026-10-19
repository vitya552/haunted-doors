# Haunted Doors

![Haunted Doors](web/public/art/cover.jpg)

A confidential trick-or-treat game on [Tari Ootle](https://ootle.tari.com), built for the Tari October Build Contest "Spooky Secrets".

A host hides treats and tricks behind the doors of a haunted house and seals the layout on chain as a Merkle root. Players pay to knock on a door with a one-time key; the host must open the door with a Merkle proof or forfeit a bond. Treats are paid to players as fresh stealth outputs - the chain never learns who knocked, who won, or how much.

- Template on Esmeralda: `template_2fcf98c66e524bba67311e6b4c21bf8b528103bccd5e19091fca840cba789563`
- Demo house: `component_ed3f54960db166d35ae0211b1ee8335783ecb97d92a3712e7460b79b0c52d0c6`
- Live demo: see the contest submission post (static Vite build of `web/`)

## What is private, and what is not

| Fact | Visible on chain? |
| --- | --- |
| What hides behind an unopened door | No - only a Merkle root of `sha256(domain ‖ house_id ‖ door ‖ prize ‖ salt)` leaves is stored. Salts are 32 random bytes per door, so the root reveals nothing even for a 2-door house. |
| Which account knocked | No - a knock is authorised by a Schnorr signature of a fresh one-time key and paid from a stealth UTXO; the seal signer of the transaction is that same throwaway key. |
| Which account received a treat | No - `claim` returns a bucket that the player's transaction turns into a stealth output (hidden amount, hidden owner, one-time address). |
| How much a player won | No - the payout is a stealth output. The prize of an opened door is public in the house state, but it is not linked to any wallet. |
| That door `n` was knocked at epoch `e`, and what was behind it once opened | Yes - the game state is a public component. This is the game: the host cannot hide an open door and the player cannot deny a knock. |
| Transaction timing and fees | Yes - like any Ootle transaction. Knock, reveal and claim are three transactions; an observer can correlate them by time. |
| The host's one-time key | Yes - it is part of the house. The host's funding source is a stealth input, so the key is not linked to an account. |

Privacy comes from three Ootle primitives: stealth UTXOs for every payment in and out, custom-domain Schnorr signatures for authorisation without accounts, and Merkle commitments for the sealed layout. The component has `OwnerRule::None` - nobody, including the host, has owner authority over the pool.

## How a round works

1. `open(host_key, house_id, doors, layout_root, knock_price, bond_per_door, reveal_window, close_epoch, funding)` - the host seals the layout and deposits `sum(prizes) + bond_per_door * doors`. The funding bucket comes from a stealth transfer in the same transaction.
2. `knock(player_key, door, signature, payment)` - a player pays `knock_price` from a stealth UTXO and binds a fresh one-time key to the door. Each key can knock once per house; each door can be knocked once.
3. `reveal(door, prize, salt, proof, signature)` - the host opens the door within `reveal_window` epochs. The template recomputes the leaf and the Merkle path against `layout_root`; a wrong prize, salt or proof is rejected.
4. `claim(door)` - the player's transaction, sealed by the same one-time key, receives the prize as a bucket and turns it into a stealth output in the same transaction (`StealthTransfer` with a revealed input bucket, fee paid from the bucket).
5. `claim_timeout(door)` - if the host stays silent past the window, the player takes `knock_price + bond_per_door` the same way.
6. `settle_trick(door)` - anyone may mark a revealed trick as settled.
7. `close()` - once every door is knocked or the house expired, and every knocked door is settled, the host collects the rest of the pool as a stealth output.

The host cannot open doors that nobody knocked, cannot reveal after the window, cannot drain the pool while prizes are owed, and cannot promise more than the pool holds (`reveal` checks `prize <= pool - owed - reserved bonds`).

## Repository layout

```
src/lib.rs            Ootle template (Rust -> wasm32-unknown-unknown)
tests/                 engine tests on tari_template_test_tooling (6 scenarios) and a vector printer
web/src/lib/           browser SDK: Schnorr (Blake2b challenge, ristretto255), CBOR args, Merkle, stealth tx builders
web/src/App.tsx        the game UI (wallet, knock, haunt)
web/scripts/live.ts    the same flows from Node, used for the Esmeralda proof run
```

## Build and test

```bash
rustup target add wasm32-unknown-unknown
cargo test
cargo build --target wasm32-unknown-unknown --release   # ~155 KB wasm
cd web && pnpm install && pnpm build                     # static site in web/dist
pnpm dev                                                 # http://127.0.0.1:5173
```

The browser keeps a stealth wallet (owner key + view key) in `localStorage`, scans the indexer's UTXO list and decrypts the outputs it owns, so it needs no wallet daemon. Fund it from the [Esmeralda community faucet](https://testnet-faucet.taritracker.com/).

## Proof run on Esmeralda

| Step | Transaction |
| --- | --- |
| open (4 doors, 20/0/10/0 tXTR, knock 5, bond 2) | `3424e2a4b81870fae6f0df117706ebed80606f3ec2ebfed4afaa53cae2232232` |
| knock door 1 (SDK) | `e0aca972e54cbf6c36f835199bac655481a58e225cab13911a6672f5c7653745` |
| reveal door 1 | `29bf23dffe528a986ab6a7f7eeebec72b02f07b1da82041625d04e91451afee0` |
| claim 20 tXTR as a stealth output | `1d62d650766f95ce5ca5a515f2cf0fffa46120913f28abba6e6286c012871999` |
| knock door 2, reveal a trick, settle | `44068b58…3b16`, `0eec7f79…afa7`, `00439947…dbd0` |
| knock door 3 from the browser demo | `0f8f8265…97eb4` (see the explorer for the full id) |
| claim 10 tXTR from the browser demo | `21dcba2f…5910` |

Every transaction committed with fees of 0.01-0.02 tXTR. Explorer: `https://explorer.tari.mw/tx/<id>` (template: `https://explorer.tari.mw/template/<id>`, house: `https://explorer.tari.mw/substate/<id>`).

## Design notes

- Signatures use `custom_signature_domain!(DoorsDomain, b"haunted-doors/sig/v1")`; the challenge is `Blake2b-512(domain ‖ nonce ‖ pubkey ‖ message)` reduced to a scalar, which `web/src/lib/schnorr.ts` reproduces with `@noble/curves`. Messages are length-prefixed `(action, house address, payload)` tuples, so a knock signature for one house cannot be replayed in another.
- Payout methods authenticate the transaction's seal signer instead of taking a `StealthTransferStatement` argument, which keeps the browser client on the SDK's native `StealthTransfer` instruction and lets the fee be paid from the payout itself.
- Merkle trees duplicate the last node on odd levels; proofs are bounded by `MAX_DOORS = 64`.
- Randomness for salts, keys and nonces comes from the client (`crypto.getRandomValues`), never from the chain.

## Known limitations

- Timing correlation between knock, reveal and claim is not hidden.
- The reveal window is counted in epochs, which are long on Esmeralda.
- A view key for an auditor ("the keeper sees the pool but cannot spend") is not implemented.

MIT licensed. Tari, Ootle and the SDK are the work of the Tari project; this repository contains only the game.
