#![allow(dead_code)]

use sha2::{Digest, Sha256, Sha512};
pub use tari_ootle_common_types::RistrettoSchnorrBlake2bVerifier;
pub use tari_template_lib_types::{
    constants::TARI_TOKEN,
    crypto::{RistrettoPublicKeyBytes, Signature},
    custom_signature_domain,
    stealth::StealthTransferStatement,
    Amount, ComponentAddress, Hash32, NonFungibleAddress,
};
pub use tari_template_test_tooling::{
    byte_type::ToByteType,
    crypto::{PublicKey, RistrettoPublicKey, RistrettoSchnorr, RistrettoSecretKey, SecretKey},
    engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId},
    support::{
        assert_error::assert_reject_reason,
        stealth::{generate_transfer_data, generate_transfer_data_to, StealthSecretTransferData, NO_INPUTS},
    },
    transaction::{args, builder::named_args::NamedArg, Transaction},
    TemplateTest,
};

pub const DOMAIN_LEAF: &[u8] = b"haunted-doors/leaf/v1";
pub const DOMAIN_NODE: &[u8] = b"haunted-doors/node/v1";
pub const SIG_DOMAIN: &[u8] = b"haunted-doors/sig/v1";

pub const MSG_KNOCK: &[u8] = b"knock";
pub const MSG_REVEAL: &[u8] = b"reveal";

custom_signature_domain!(DoorsDomain, b"haunted-doors/sig/v1");
pub type DoorsSignature = Signature<DoorsDomain>;

pub const START_EPOCH: u64 = 10;
pub const REVEAL_WINDOW: u64 = 3;
pub const CLOSE_EPOCH: u64 = START_EPOCH + 20;
pub const KNOCK_PRICE: u64 = 100;
pub const BOND_PER_DOOR: u64 = 50;
pub const PRIZES: [u64; 4] = [500, 0, 200, 0];

pub fn a(v: u64) -> Amount {
    Amount::from_u64(v)
}

fn len_prefixed(data: &[u8]) -> Vec<u8> {
    let mut out = (data.len() as u64).to_le_bytes().to_vec();
    out.extend_from_slice(data);
    out
}

pub fn action_message(action: &[u8], house: &[u8], payload: &[&[u8]]) -> Vec<u8> {
    let mut msg = len_prefixed(action);
    msg.extend(len_prefixed(house));
    for part in payload {
        msg.extend(len_prefixed(part));
    }
    msg
}

pub fn door_leaf(house_id: &[u8; 32], door: u8, prize: u64, salt: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(len_prefixed(DOMAIN_LEAF));
    h.update(house_id);
    h.update([door]);
    h.update(a(prize).to_le_bytes());
    h.update(salt);
    h.finalize().into()
}

pub fn merkle_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(len_prefixed(DOMAIN_NODE));
    h.update(left);
    h.update(right);
    h.finalize().into()
}

pub struct Key {
    pub seed: Vec<u8>,
    pub secret: RistrettoSecretKey,
    pub public: RistrettoPublicKeyBytes,
}

impl Key {
    pub fn new(label: &str) -> Self {
        let seed = Sha512::digest(format!("haunted doors test key {label}").as_bytes()).to_vec();
        let secret = RistrettoSecretKey::from_uniform_bytes(&seed).unwrap();
        let public = RistrettoPublicKey::from_secret_key(&secret).to_byte_type();
        Self { seed, secret, public }
    }

    pub fn sign(&self, message: &[u8]) -> DoorsSignature {
        let mut h = Sha512::new();
        h.update(&self.seed);
        h.update(b"nonce");
        h.update(message);
        let nonce = RistrettoSecretKey::from_uniform_bytes(&h.finalize()).unwrap();
        let nonce_pub = RistrettoPublicKey::from_secret_key(&nonce).to_byte_type();
        let challenge = RistrettoSchnorrBlake2bVerifier::compute_challenge(SIG_DOMAIN, message, &self.public, &nonce_pub);
        let sig = RistrettoSchnorr::sign_raw_uniform(&self.secret, nonce, &challenge).unwrap();
        DoorsSignature::new(sig.to_byte_type())
    }
}

pub struct Layout {
    pub house_id: [u8; 32],
    pub prizes: Vec<u64>,
    pub salts: Vec<[u8; 32]>,
}

impl Layout {
    pub fn new(label: &str, prizes: &[u64]) -> Self {
        let house_id: [u8; 32] = Sha256::digest(format!("house {label}").as_bytes()).into();
        let salts = (0..prizes.len())
            .map(|i| Sha256::digest(format!("salt {label} {i}").as_bytes()).into())
            .collect();
        Self {
            house_id,
            prizes: prizes.to_vec(),
            salts,
        }
    }

    pub fn doors(&self) -> u8 {
        self.prizes.len() as u8
    }

    fn levels(&self) -> Vec<Vec<[u8; 32]>> {
        let mut level: Vec<[u8; 32]> = (0..self.prizes.len())
            .map(|i| door_leaf(&self.house_id, i as u8, self.prizes[i], &self.salts[i]))
            .collect();
        let mut levels = vec![level.clone()];
        while level.len() > 1 {
            let mut next = Vec::new();
            for pair in level.chunks(2) {
                let right = pair.get(1).unwrap_or(&pair[0]);
                next.push(merkle_node(&pair[0], right));
            }
            level = next;
            levels.push(level.clone());
        }
        levels
    }

    pub fn root(&self) -> Hash32 {
        Hash32::from_array(*self.levels().last().unwrap().first().unwrap())
    }

    pub fn proof(&self, door: u8) -> Vec<Hash32> {
        let mut proof = Vec::new();
        let mut index = door as usize;
        for level in self.levels() {
            if level.len() == 1 {
                break;
            }
            let sibling = index ^ 1;
            if index % 2 == 1 || sibling < level.len() {
                proof.push(Hash32::from_array(level[sibling]));
            }
            index /= 2;
        }
        proof
    }
}

pub struct Coin {
    pub data: StealthSecretTransferData,
    pub value: u64,
}

impl Coin {
    pub fn key(&self) -> &RistrettoSecretKey {
        &self.data.output_masks[0]
    }

    pub fn public(&self) -> RistrettoPublicKeyBytes {
        RistrettoPublicKey::from_secret_key(self.key()).to_byte_type()
    }

    pub fn spend_to_bucket(&self) -> StealthTransferStatement {
        generate_transfer_data_to(
            [self.data.input_spec_for(0, self.value)],
            Amount::zero(),
            Vec::<u64>::new(),
            Amount::from_u64(self.value),
            self.public(),
        )
        .statement
    }
}

pub fn set_epoch(test: &mut TemplateTest, epoch: u64) {
    test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(epoch));
}

pub struct World {
    pub test: TemplateTest,
    pub bank: (ComponentAddress, NonFungibleAddress, RistrettoSecretKey),
    pub host: Key,
    pub layout: Layout,
}

impl World {
    pub fn new() -> Self {
        let mut test = TemplateTest::new_cwd(["."]);
        set_epoch(&mut test, START_EPOCH);
        let bank = test.create_funded_account();
        Self {
            test,
            bank,
            host: Key::new("host"),
            layout: Layout::new("manor", &PRIZES),
        }
    }

    pub fn epoch(&mut self, epoch: u64) {
        set_epoch(&mut self.test, epoch);
    }

    pub fn coin(&mut self, value: u64) -> Coin {
        let data = generate_transfer_data(NO_INPUTS, Amount::from_u64(value), [value], Amount::zero());
        let (account, proof, key) = (self.bank.0, self.bank.1.clone(), self.bank.2.clone());
        let tx = self
            .test
            .transaction()
            .call_method(account, "withdraw", args![TARI_TOKEN, Amount::from_u64(value)])
            .put_last_instruction_output_on_workspace("funds")
            .stealth_transfer_with_input_bucket(TARI_TOKEN, data.statement.clone(), "funds")
            .build_and_seal(&key);
        self.test.execute_expect_success(tx, vec![proof]);
        Coin { data, value }
    }

    pub fn funding(&self) -> u64 {
        self.layout.prizes.iter().sum::<u64>() + BOND_PER_DOOR * self.layout.prizes.len() as u64
    }

    pub fn open(&mut self) -> ComponentAddress {
        let funding = self.funding();
        self.open_with(funding)
    }

    pub fn open_with(&mut self, funding: u64) -> ComponentAddress {
        let template = self.test.get_template_address("HauntedHouse");
        let coin = self.coin(funding);
        let tx = self
            .test
            .transaction()
            .stealth_transfer(TARI_TOKEN, coin.spend_to_bucket())
            .put_last_instruction_output_on_workspace("funding")
            .call_function(
                template,
                "open",
                args![
                    self.host.public,
                    Hash32::from_array(self.layout.house_id),
                    self.layout.doors(),
                    self.layout.root(),
                    a(KNOCK_PRICE),
                    a(BOND_PER_DOOR),
                    REVEAL_WINDOW,
                    CLOSE_EPOCH,
                    Workspace("funding")
                ],
            )
            .build_and_seal(coin.key());
        self.test.execute_expect_success(tx, vec![]);
        let houses = self
            .test
            .read_only_state_store()
            .get_component_addresses_by_template_address(template)
            .unwrap();
        *houses.last().expect("open creates the house component")
    }

    pub fn knock_tx(&mut self, house: ComponentAddress, player: &Key, door: u8, signature: DoorsSignature, payment: u64) -> Transaction {
        let coin = self.coin(payment);
        self.test
            .transaction()
            .stealth_transfer(TARI_TOKEN, coin.spend_to_bucket())
            .put_last_instruction_output_on_workspace("payment")
            .call_method(house, "knock", args![player.public, door, signature, Workspace("payment")])
            .build_and_seal(coin.key())
    }

    pub fn knock_sig(house: ComponentAddress, signer: &Key, door: u8) -> DoorsSignature {
        signer.sign(&action_message(MSG_KNOCK, house.as_bytes(), &[&[door]]))
    }

    pub fn knock(&mut self, house: ComponentAddress, player: &Key, door: u8) {
        let sig = Self::knock_sig(house, player, door);
        let tx = self.knock_tx(house, player, door, sig, KNOCK_PRICE);
        self.test.execute_expect_success(tx, vec![]);
    }

    pub fn knock_refused(&mut self, house: ComponentAddress, player: &Key, door: u8, signature: DoorsSignature, payment: u64, reason: &str) {
        let tx = self.knock_tx(house, player, door, signature, payment);
        let rejected = self.test.execute_expect_failure(tx, vec![]);
        assert_reject_reason(rejected, reason);
    }

    pub fn reveal_args(&self, house: ComponentAddress, signer: &Key, door: u8, prize: u64, salt: [u8; 32], proof: Vec<Hash32>) -> Vec<NamedArg> {
        let sig = signer.sign(&action_message(
            MSG_REVEAL,
            house.as_bytes(),
            &[&[door], &a(prize).to_le_bytes(), &salt],
        ));
        args![door, a(prize), Hash32::from_array(salt), proof, sig]
    }

    pub fn reveal(&mut self, house: ComponentAddress, door: u8) {
        let prize = self.layout.prizes[door as usize];
        let salt = self.layout.salts[door as usize];
        let proof = self.layout.proof(door);
        let host = Key::new("host");
        let args = self.reveal_args(house, &host, door, prize, salt, proof);
        self.ok(house, "reveal", args);
    }

    pub fn call_tx(&self, house: ComponentAddress, method: &str, args: Vec<NamedArg>) -> Transaction {
        self.test
            .transaction()
            .call_method(house, method, args)
            .build_and_seal(self.test.secret_key())
    }

    pub fn ok(&mut self, house: ComponentAddress, method: &str, args: Vec<NamedArg>) {
        let tx = self.call_tx(house, method, args);
        self.test.execute_expect_success(tx, vec![]);
    }

    pub fn refused(&mut self, house: ComponentAddress, method: &str, args: Vec<NamedArg>, reason: &str) {
        let tx = self.call_tx(house, method, args);
        let rejected = self.test.execute_expect_failure(tx, vec![]);
        assert_reject_reason(rejected, reason);
    }

    pub fn payout(amount: u64) -> StealthSecretTransferData {
        generate_transfer_data(NO_INPUTS, Amount::from_u64(amount), [amount], Amount::zero())
    }

    pub fn payout_tx(&self, house: ComponentAddress, method: &str, door: Option<u8>, signer: &Key, amount: u64) -> (Transaction, StealthSecretTransferData) {
        let data = Self::payout(amount);
        let args = match door {
            Some(d) => args![d],
            None => args![],
        };
        let tx = self
            .test
            .transaction()
            .call_method(house, method, args)
            .put_last_instruction_output_on_workspace("pay")
            .stealth_transfer_with_input_bucket(TARI_TOKEN, data.statement.clone(), "pay")
            .build_and_seal(&signer.secret);
        (tx, data)
    }

    pub fn payout_ok(&mut self, house: ComponentAddress, method: &str, door: Option<u8>, signer: &Key, amount: u64) -> Coin {
        let (tx, data) = self.payout_tx(house, method, door, signer, amount);
        self.test.execute_expect_success(tx, vec![]);
        Coin { data, value: amount }
    }

    pub fn payout_refused(&mut self, house: ComponentAddress, method: &str, door: Option<u8>, signer: &Key, amount: u64, reason: &str) {
        let (tx, _) = self.payout_tx(house, method, door, signer, amount);
        let rejected = self.test.execute_expect_failure(tx, vec![]);
        assert_reject_reason(rejected, reason);
    }

    pub fn claim(&mut self, house: ComponentAddress, player: &Key, door: u8, amount: u64) -> Coin {
        self.payout_ok(house, "claim", Some(door), player, amount)
    }

    pub fn claim_timeout(&mut self, house: ComponentAddress, player: &Key, door: u8, amount: u64) -> Coin {
        self.payout_ok(house, "claim_timeout", Some(door), player, amount)
    }

    pub fn close(&mut self, house: ComponentAddress, amount: u64) -> Coin {
        let host = Key::new("host");
        self.payout_ok(house, "close", None, &host, amount)
    }

    pub fn bank_balance(&mut self) -> Amount {
        let account = self.bank.0;
        self.test.call_method(account, "balance", args![TARI_TOKEN], vec![])
    }

    pub fn redeem(&mut self, coin: &Coin) {
        let before = self.bank_balance();
        let account = self.bank.0;
        let tx = self
            .test
            .transaction()
            .stealth_transfer(TARI_TOKEN, coin.spend_to_bucket())
            .put_last_instruction_output_on_workspace("redeemed")
            .call_method(account, "deposit", args![Workspace("redeemed")])
            .build_and_seal(coin.key());
        self.test.execute_expect_success(tx, vec![]);
        assert_eq!(self.bank_balance(), before + coin.value);
    }

    pub fn pool(&mut self, house: ComponentAddress) -> Amount {
        self.test.call_method(house, "pool_balance", args![], vec![])
    }

    pub fn owed_total(&mut self, house: ComponentAddress) -> Amount {
        self.test.call_method(house, "owed_total", args![], vec![])
    }

    pub fn is_closed(&mut self, house: ComponentAddress) -> bool {
        self.test.call_method(house, "is_closed", args![], vec![])
    }
}
