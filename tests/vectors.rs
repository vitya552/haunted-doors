mod common;

use common::*;
use sha2::{Digest, Sha512};
use tari_utilities::ByteArray;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[test]
fn print_vectors() {
    let key = Key::new("vector");
    let message = action_message(MSG_KNOCK, &[7u8; 32], &[&[3u8]]);
    let mut h = Sha512::new();
    h.update(&key.seed);
    h.update(b"nonce");
    h.update(&message);
    let nonce = RistrettoSecretKey::from_uniform_bytes(&h.finalize()).unwrap();
    let nonce_pub = RistrettoPublicKey::from_secret_key(&nonce).to_byte_type();
    let challenge = RistrettoSchnorrBlake2bVerifier::compute_challenge(SIG_DOMAIN, &message, &key.public, &nonce_pub);
    let sig = RistrettoSchnorr::sign_raw_uniform(&key.secret, nonce.clone(), &challenge).unwrap();
    let doors_sig = DoorsSignature::new(sig.to_byte_type());
    println!("VEC secret {}", hex(key.secret.as_bytes()));
    println!("VEC public {}", hex(key.public.as_bytes()));
    println!("VEC nonce_secret {}", hex(nonce.as_bytes()));
    println!("VEC nonce_public {}", hex(nonce_pub.as_bytes()));
    println!("VEC message {}", hex(&message));
    println!("VEC challenge {}", hex(&challenge));
    println!("VEC s {}", hex(sig.get_signature().as_bytes()));
    println!("VEC cbor_signature {}", hex(&tari_bor::encode(&doors_sig).unwrap()));
    println!("VEC cbor_pubkey {}", hex(&tari_bor::encode(&key.public).unwrap()));
    println!("VEC cbor_hash32 {}", hex(&tari_bor::encode(&Hash32::from_array([9u8; 32])).unwrap()));
    println!("VEC cbor_vec_hash32 {}", hex(&tari_bor::encode(&vec![Hash32::from_array([1u8; 32]), Hash32::from_array([2u8; 32])]).unwrap()));
    println!("VEC cbor_amount_500 {}", hex(&tari_bor::encode(&a(500)).unwrap()));
    println!("VEC cbor_u8_3 {}", hex(&tari_bor::encode(&3u8).unwrap()));
    println!("VEC cbor_u64_12 {}", hex(&tari_bor::encode(&12u64).unwrap()));
    let layout = Layout::new("manor", &PRIZES);
    println!("VEC house_id {}", hex(&layout.house_id));
    println!("VEC salt0 {}", hex(&layout.salts[0]));
    println!("VEC root {}", hex(layout.root().as_ref()));
    println!("VEC proof0 {}", layout.proof(0).iter().map(|h| hex(h.as_ref())).collect::<Vec<_>>().join(","));
}
