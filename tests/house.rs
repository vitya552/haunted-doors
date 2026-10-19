mod common;

use common::*;

#[test]
fn treats_are_paid_into_stealth_outputs_and_the_host_collects_the_rest() {
    let mut w = World::new();
    let house = w.open();
    assert_eq!(w.pool(house), a(900));

    let alice = Key::new("alice");
    let bob = Key::new("bob");
    w.knock(house, &alice, 0);
    w.knock(house, &bob, 1);
    assert_eq!(w.pool(house), a(1100));

    w.reveal(house, 0);
    w.reveal(house, 1);
    assert_eq!(w.owed_total(house), a(500));

    let treat = w.claim(house, &alice, 0, 500);
    w.redeem(&treat);
    assert_eq!(w.owed_total(house), a(0));
    w.payout_refused(house, "claim", Some(1), &bob, 1, "a trick: nothing to claim");
    w.ok(house, "settle_trick", args![1u8]);

    w.payout_refused(house, "close", None, &Key::new("host"), 600, "knocking is still open");
    w.epoch(CLOSE_EPOCH + 1);
    let rest = w.close(house, 600);
    w.redeem(&rest);
    assert!(w.is_closed(house));
}

#[test]
fn a_door_that_does_not_match_the_sealed_layout_is_rejected() {
    let mut w = World::new();
    let house = w.open();
    let alice = Key::new("alice");
    w.knock(house, &alice, 0);

    let salt = w.layout.salts[0];
    let proof = w.layout.proof(0);
    let host = Key::new("host");
    let bad_prize = w.reveal_args(house, &host, 0, 1, salt, proof.clone());
    w.refused(house, "reveal", bad_prize, "does not match the sealed layout");

    let other_salt = w.layout.salts[1];
    let bad_salt = w.reveal_args(house, &host, 0, 500, other_salt, proof.clone());
    w.refused(house, "reveal", bad_salt, "does not match the sealed layout");

    let short_proof = w.reveal_args(house, &host, 0, 500, salt, proof[..1].to_vec());
    w.refused(house, "reveal", short_proof, "merkle proof too short");

    let forged = w.reveal_args(house, &alice, 0, 500, salt, proof);
    w.refused(house, "reveal", forged, "invalid reveal signature");

    w.reveal(house, 0);
}

#[test]
fn a_silent_host_pays_the_knock_back_plus_the_bond() {
    let mut w = World::new();
    let house = w.open();
    let alice = Key::new("alice");
    w.knock(house, &alice, 2);

    w.payout_refused(house, "claim_timeout", Some(2), &alice, 150, "still has time");

    w.epoch(START_EPOCH + REVEAL_WINDOW + 1);
    let salt = w.layout.salts[2];
    let proof = w.layout.proof(2);
    let late = w.reveal_args(house, &Key::new("host"), 2, 200, salt, proof);
    w.refused(house, "reveal", late, "reveal window has passed");

    w.payout_refused(house, "claim_timeout", Some(2), &alice, 151, "does not match the statement's revealed input amount");
    w.payout_refused(house, "claim_timeout", Some(2), &Key::new("mallory"), 150, "must be sealed by the one-time key");

    let refund = w.claim_timeout(house, &alice, 2, 150);
    w.redeem(&refund);
    assert_eq!(w.pool(house), a(850));

    w.epoch(CLOSE_EPOCH + 1);
    w.payout_refused(house, "close", None, &alice, 850, "must be sealed by the one-time key");
    let rest = w.close(house, 850);
    w.redeem(&rest);
}

#[test]
fn knocking_is_guarded() {
    let mut w = World::new();
    let house = w.open();
    let alice = Key::new("alice");
    let bob = Key::new("bob");
    w.knock(house, &alice, 0);

    let sig = World::knock_sig(house, &bob, 0);
    w.knock_refused(house, &bob, 0, sig, KNOCK_PRICE, "already knocked");

    let sig = World::knock_sig(house, &bob, 1);
    w.knock_refused(house, &bob, 1, sig, KNOCK_PRICE + 1, "must equal the knock price");

    let sig = World::knock_sig(house, &alice, 1);
    w.knock_refused(house, &bob, 1, sig, KNOCK_PRICE, "invalid knock signature");

    let sig = World::knock_sig(house, &alice, 1);
    w.knock_refused(house, &alice, 1, sig, KNOCK_PRICE, "already used in this house");

    let sig = World::knock_sig(house, &bob, 9);
    w.knock_refused(house, &bob, 9, sig, KNOCK_PRICE, "no such door");

    w.epoch(CLOSE_EPOCH + 1);
    let sig = World::knock_sig(house, &bob, 1);
    w.knock_refused(house, &bob, 1, sig, KNOCK_PRICE, "knocking is over");
}

#[test]
fn only_the_player_can_claim_and_only_once() {
    let mut w = World::new();
    let house = w.open();
    let alice = Key::new("alice");
    let mallory = Key::new("mallory");
    w.knock(house, &alice, 0);

    w.payout_refused(house, "claim", Some(0), &alice, 500, "not open yet");

    w.reveal(house, 0);
    w.payout_refused(house, "claim", Some(0), &mallory, 500, "must be sealed by the one-time key");
    w.refused(house, "claim", args![0u8], "must be sealed by the one-time key");

    w.epoch(CLOSE_EPOCH + 1);
    w.payout_refused(house, "close", None, &Key::new("host"), 600, "some doors are not settled yet");

    let treat = w.claim(house, &alice, 0, 500);
    w.redeem(&treat);
    w.payout_refused(house, "claim", Some(0), &alice, 500, "already settled");
}

#[test]
fn the_house_cannot_be_opened_without_the_bond() {
    let mut w = World::new();
    let template = w.test.get_template_address("HauntedHouse");
    let coin = w.coin(100);
    let tx = w
        .test
        .transaction()
        .stealth_transfer(TARI_TOKEN, coin.spend_to_bucket())
        .put_last_instruction_output_on_workspace("funding")
        .call_function(
            template,
            "open",
            args![
                w.host.public,
                Hash32::from_array(w.layout.house_id),
                w.layout.doors(),
                w.layout.root(),
                a(KNOCK_PRICE),
                a(BOND_PER_DOOR),
                REVEAL_WINDOW,
                CLOSE_EPOCH,
                Workspace("funding")
            ],
        )
        .build_and_seal(coin.key());
    let rejected = w.test.execute_expect_failure(tx, vec![]);
    assert_reject_reason(rejected, "funding must cover the bond");
}
