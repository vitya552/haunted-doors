
use tari_template_lib::prelude::*;

pub const DOMAIN_LEAF: &[u8] = b"haunted-doors/leaf/v1";
pub const DOMAIN_NODE: &[u8] = b"haunted-doors/node/v1";

pub const MSG_KNOCK: &[u8] = b"knock";
pub const MSG_REVEAL: &[u8] = b"reveal";

pub const MIN_DOORS: u8 = 2;
pub const MAX_DOORS: u8 = 64;
pub const MIN_WINDOW: u64 = 1;
pub const MAX_WINDOW: u64 = 10_000;

custom_signature_domain!(DoorsDomain, b"haunted-doors/sig/v1");

pub type DoorsSignature = Signature<DoorsDomain>;

fn len_prefixed(data: &[u8]) -> Vec<u8> {
    let mut out = (data.len() as u64).to_le_bytes().to_vec();
    out.extend_from_slice(data);
    out
}

pub fn door_leaf(house_id: &Hash32, door: u8, prize: Amount, salt: &Hash32) -> Hash32 {
    let domain = len_prefixed(DOMAIN_LEAF);
    intrinsics::hash_sha256_parts(&[&domain, house_id.as_ref(), &[door], &prize.to_le_bytes(), salt.as_ref()])
}

pub fn merkle_node(left: &Hash32, right: &Hash32) -> Hash32 {
    let domain = len_prefixed(DOMAIN_NODE);
    intrinsics::hash_sha256_parts(&[&domain, left.as_ref(), right.as_ref()])
}

pub fn merkle_root_from_proof(leaf: Hash32, index: u8, leaf_count: u8, proof: &[Hash32]) -> Hash32 {
    let mut node = leaf;
    let mut index = index as usize;
    let mut width = leaf_count as usize;
    let mut used = 0;
    while width > 1 {
        let sibling = if index % 2 == 0 {
            if index + 1 < width {
                let s = proof.get(used).expect("merkle proof too short");
                used += 1;
                *s
            } else {
                node
            }
        } else {
            let s = proof.get(used).expect("merkle proof too short");
            used += 1;
            *s
        };
        node = if index % 2 == 0 {
            merkle_node(&node, &sibling)
        } else {
            merkle_node(&sibling, &node)
        };
        index /= 2;
        width = (width + 1) / 2;
    }
    assert!(used == proof.len(), "merkle proof too long");
    node
}

pub fn action_message(action: &[u8], house: &[u8], payload: &[&[u8]]) -> Vec<u8> {
    let mut msg = len_prefixed(action);
    msg.extend(len_prefixed(house));
    for part in payload {
        msg.extend(len_prefixed(part));
    }
    msg
}

fn assert_valid_key(key: &RistrettoPublicKeyBytes, what: &str) {
    assert!(intrinsics::ristretto_is_canonical(key), "{} is not a canonical Ristretto point", what);
    assert!(!intrinsics::ristretto_is_identity(key), "{} must not be the identity point", what);
}

fn assert_signed(key: &RistrettoPublicKeyBytes, message: &[u8], signature: &DoorsSignature, what: &str) {
    assert!(
        signature.verify(&PublicKey::from(*key), message),
        "not authorized: invalid {} signature",
        what
    );
}

#[derive(Debug, Clone, PartialEq, Eq, minicbor::Encode, minicbor::Decode, minicbor::CborLen)]
pub struct Door {
    #[n(0)]
    pub player: Option<RistrettoPublicKeyBytes>,
    #[n(1)]
    pub knocked_at: u64,
    #[n(2)]
    pub prize: Option<Amount>,
    #[n(3)]
    pub owed: Amount,
    #[n(4)]
    pub settled: bool,
}

impl Door {
    fn closed() -> Self {
        Self {
            player: None,
            knocked_at: 0,
            prize: None,
            owed: Amount::zero(),
            settled: false,
        }
    }
}

#[template]
mod haunted_doors {
    use super::*;

    pub struct HauntedHouse {
        host_key: RistrettoPublicKeyBytes,
        house_id: Hash32,
        layout_root: Hash32,
        knock_price: Amount,
        bond_per_door: Amount,
        reveal_window: u64,
        close_epoch: u64,
        doors: Vec<Door>,
        pool: Vault,
        owed_total: Amount,
        closed: bool,
    }

    impl HauntedHouse {
        pub fn open(
            host_key: RistrettoPublicKeyBytes,
            house_id: Hash32,
            doors: u8,
            layout_root: Hash32,
            knock_price: Amount,
            bond_per_door: Amount,
            reveal_window: u64,
            close_epoch: u64,
            funding: Bucket,
        ) -> Component<Self> {
            assert_valid_key(&host_key, "host key");
            assert!((MIN_DOORS..=MAX_DOORS).contains(&doors), "doors must be between {} and {}", MIN_DOORS, MAX_DOORS);
            assert!(knock_price.is_positive(), "knock price must be positive");
            assert!(!bond_per_door.is_negative(), "bond must not be negative");
            assert!(
                (MIN_WINDOW..=MAX_WINDOW).contains(&reveal_window),
                "reveal window must be between {} and {} epochs",
                MIN_WINDOW,
                MAX_WINDOW
            );
            let now = Consensus::current_epoch();
            assert!(close_epoch > now, "close epoch must be in the future");
            assert!(funding.resource_address() == TARI_TOKEN, "only XTM is accepted");
            let bond_total = bond_per_door * doors as u64;
            assert!(funding.amount() >= bond_total, "funding must cover the bond");

            emit_event(
                "house_opened",
                metadata! {
                    "doors" => doors.to_string(),
                    "knock_price" => knock_price.to_string(),
                    "close_epoch" => close_epoch.to_string()
                },
            );
            let pool = Vault::new_empty(TARI_TOKEN);
            pool.deposit(funding);
            Component::new(Self {
                host_key,
                house_id,
                layout_root,
                knock_price,
                bond_per_door,
                reveal_window,
                close_epoch,
                doors: (0..doors).map(|_| Door::closed()).collect(),
                pool,
                owed_total: Amount::zero(),
                closed: false,
            })
            .with_access_rules(AccessRules::allow_all())
            .with_owner_rule(OwnerRule::None)
            .create()
        }

        pub fn knock(&mut self, player_key: RistrettoPublicKeyBytes, door: u8, signature: DoorsSignature, payment: Bucket) {
            assert!(!self.closed, "the house is closed");
            assert!(Consensus::current_epoch() <= self.close_epoch, "knocking is over");
            assert!(payment.resource_address() == TARI_TOKEN, "only XTM is accepted");
            assert!(payment.amount() == self.knock_price, "payment must equal the knock price");
            assert_valid_key(&player_key, "player key");
            assert!(player_key != self.host_key, "the host key cannot knock");
            assert!(self.doors.iter().all(|d| d.player != Some(player_key)), "player key already used in this house");
            let slot = self.door_mut(door);
            assert!(slot.player.is_none(), "this door was already knocked");
            let message = action_message(MSG_KNOCK, &Self::context(), &[&[door]]);
            assert_signed(&player_key, &message, &signature, "knock");
            slot.player = Some(player_key);
            slot.knocked_at = Consensus::current_epoch();
            self.pool.deposit(payment);
            emit_event("door_knocked", metadata! { "door" => door.to_string() });
        }

        pub fn reveal(&mut self, door: u8, prize: Amount, salt: Hash32, proof: Vec<Hash32>, signature: DoorsSignature) {
            assert!(!prize.is_negative(), "prize must not be negative");
            let message = action_message(MSG_REVEAL, &Self::context(), &[&[door], &prize.to_le_bytes(), salt.as_ref()]);
            assert_signed(&self.host_key, &message, &signature, "reveal");
            let house_id = self.house_id;
            let leaf_count = self.doors.len() as u8;
            let root = self.layout_root;
            let reveal_window = self.reveal_window;
            let available = self.pool.balance() - self.owed_total - self.bond_reserved();
            let slot = self.door_mut(door);
            assert!(slot.player.is_some(), "nobody knocked on this door");
            assert!(slot.prize.is_none(), "this door is already open");
            assert!(
                Consensus::current_epoch() <= slot.knocked_at + reveal_window,
                "the reveal window has passed"
            );
            let leaf = door_leaf(&house_id, door, prize, &salt);
            assert!(
                merkle_root_from_proof(leaf, door, leaf_count, &proof) == root,
                "the door does not match the sealed layout"
            );
            assert!(prize <= available, "the pool cannot cover this prize");
            slot.prize = Some(prize);
            slot.owed = prize;
            self.owed_total += prize;
            emit_event(
                "door_opened",
                metadata! { "door" => door.to_string(), "treat" => prize.is_positive().to_string() },
            );
        }

        pub fn claim(&mut self, door: u8) -> Bucket {
            let slot = self.door(door).clone();
            let player = slot.player.expect("nobody knocked on this door");
            assert!(slot.prize.is_some(), "this door is not open yet");
            assert!(!slot.settled, "this door is already settled");
            assert!(slot.owed.is_positive(), "a trick: nothing to claim");
            Self::assert_sealed_by(&player, "claim");
            self.owed_total -= slot.owed;
            self.door_mut(door).settled = true;
            self.pool.withdraw(slot.owed)
        }

        pub fn settle_trick(&mut self, door: u8) {
            let slot = self.door_mut(door);
            assert!(slot.player.is_some(), "nobody knocked on this door");
            assert!(slot.prize == Some(Amount::zero()), "this door is not a revealed trick");
            slot.settled = true;
        }

        pub fn claim_timeout(&mut self, door: u8) -> Bucket {
            let reveal_window = self.reveal_window;
            let refund = self.knock_price + self.bond_per_door;
            let slot = self.door(door).clone();
            let player = slot.player.expect("nobody knocked on this door");
            assert!(slot.prize.is_none(), "this door was opened in time");
            assert!(!slot.settled, "this door is already settled");
            assert!(
                Consensus::current_epoch() > slot.knocked_at + reveal_window,
                "the host still has time to open this door"
            );
            Self::assert_sealed_by(&player, "timeout");
            let slot = self.door_mut(door);
            slot.prize = Some(Amount::zero());
            slot.settled = true;
            emit_event("door_timed_out", metadata! { "door" => door.to_string() });
            self.pool.withdraw(refund)
        }

        pub fn close(&mut self) -> Bucket {
            assert!(!self.closed, "the house is already closed");
            let all_knocked = self.doors.iter().all(|d| d.player.is_some());
            assert!(
                all_knocked || Consensus::current_epoch() > self.close_epoch,
                "knocking is still open"
            );
            assert!(
                self.doors.iter().filter(|d| d.player.is_some()).all(|d| d.settled),
                "some doors are not settled yet"
            );
            let remaining = self.pool.balance() - self.owed_total;
            assert!(remaining.is_positive(), "nothing left to collect");
            Self::assert_sealed_by(&self.host_key, "close");
            self.closed = true;
            emit_event("house_closed", metadata! {});
            self.pool.withdraw(remaining)
        }

        pub fn door_state(&self, door: u8) -> Door {
            self.door(door).clone()
        }

        pub fn doors(&self) -> Vec<Door> {
            self.doors.clone()
        }

        pub fn pool_balance(&self) -> Amount {
            self.pool.balance()
        }

        pub fn owed_total(&self) -> Amount {
            self.owed_total
        }

        pub fn is_closed(&self) -> bool {
            self.closed
        }

        pub fn house_id(&self) -> Hash32 {
            self.house_id
        }

        pub fn layout_root(&self) -> Hash32 {
            self.layout_root
        }

        fn context() -> Vec<u8> {
            CallerContext::current_component_address().as_bytes().to_vec()
        }

        fn bond_reserved(&self) -> Amount {
            let unsettled_knocks = self.doors.iter().filter(|d| d.player.is_some() && d.prize.is_none()).count();
            self.bond_per_door * unsettled_knocks as u64
        }

        fn door(&self, door: u8) -> &Door {
            self.doors.get(door as usize).expect("no such door")
        }

        fn door_mut(&mut self, door: u8) -> &mut Door {
            self.doors.get_mut(door as usize).expect("no such door")
        }

        fn assert_sealed_by(key: &RistrettoPublicKeyBytes, what: &str) {
            assert!(
                CallerContext::transaction_signer_public_key() == *key,
                "not authorized: the {} transaction must be sealed by the one-time key",
                what
            );
        }
    }
}
