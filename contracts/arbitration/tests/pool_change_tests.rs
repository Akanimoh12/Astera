#![cfg(test)]

//! #1167: the existing re-draw coverage in `quorum_timeout_tests.rs` always
//! registers exactly `committee_size` (5) jurors, so the active pool is
//! identical on every draw and a re-draw can never actually observe a pool
//! change — silently masking the underlying #52 issue (a stale/deregistered
//! juror being reused on a committee re-draw). These tests register more
//! jurors than `committee_size` and mutate the active pool (deregistering a
//! juror who *was* on the first committee) between the first draw and the
//! forced re-draw, then assert `select_jurors` draws strictly from the
//! *current* active pool rather than reusing anything from the stale draw.

use arbitration::{
    ArbitrationContract, ArbitrationContractClient, ArbitrationError, CaseStatus,
    DisputeResolution,
};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token, Address, Env, Vec,
};

/// Minimal invoice-contract stand-in so `open_case`/`finalize_case`'s
/// cross-contract callback has something to call into.
#[contract]
pub struct DummyInvoice;

#[contractimpl]
impl DummyInvoice {
    pub fn arbitration_resolve_dispute(
        _env: Env,
        arbitration: Address,
        _id: u64,
        _outcome: DisputeResolution,
    ) {
        arbitration.require_auth();
    }
}

fn setup(env: &Env) -> (ArbitrationContractClient<'_>, Address, Address, i128) {
    env.ledger().with_mut(|l| l.timestamp = 1_000_000);
    let contract_id = env.register(ArbitrationContract, ());
    let client = ArbitrationContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let token_admin = Address::generate(env);
    let stake_token = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let invoice_id = env.register(DummyInvoice, ());
    let min_stake = 1_000i128;
    client.initialize(&admin, &invoice_id, &stake_token, &min_stake);
    (client, admin, stake_token, min_stake)
}

fn mint(env: &Env, token_id: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token_id).mint(to, &amount);
}

/// Registers 6 jurors (one more than the default `committee_size` of 5),
/// forces a no-quorum re-draw, deregisters one juror who *was* seated on the
/// first committee in between, and asserts the second draw:
///   - never reuses the now-inactive juror (the actual #52 regression), and
///   - is drawn from exactly the resulting active pool, since removing one
///     juror from a 6-juror pool leaves exactly `committee_size` (5) active
///     candidates — a deterministic outcome regardless of the PRNG shuffle.
#[test]
fn test_select_jurors_redraw_excludes_deregistered_juror_from_first_committee() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, stake_token, min_stake) = setup(&env);
    let invoice_id = client.get_invoice_contract().unwrap();

    // Register 6 jurors — one more than committee_size — so the first draw
    // necessarily benches exactly one of them.
    let mut all_jurors: Vec<Address> = Vec::new(&env);
    for _ in 0..6 {
        let operator = Address::generate(&env);
        mint(&env, &stake_token, &operator, min_stake);
        client.register_juror(&operator, &min_stake);
        all_jurors.push_back(operator);
    }

    let claimant = Address::generate(&env);
    let respondent = Address::generate(&env);
    let case_id = client.open_case(&invoice_id, &1u64, &claimant, &respondent, &5_000i128);

    // Round 1: evidence window closes, first committee drawn from the full
    // 6-juror pool (5 seated, 1 benched).
    env.ledger()
        .with_mut(|l| l.timestamp += 3 * 24 * 60 * 60 + 1);
    client.select_jurors(&case_id);
    let case_after_draw1 = client.get_case(&case_id).unwrap();
    assert_eq!(case_after_draw1.retry_count, 1);
    assert_eq!(case_after_draw1.jurors.len(), 5);

    let committee1 = case_after_draw1.jurors.clone();
    let benched: Address = all_jurors
        .iter()
        .find(|j| !committee1.contains(j))
        .expect("exactly one of the 6 registered jurors must be benched on draw 1");

    // Force a no-quorum outcome: nobody commits/reveals, so reveal_count (0)
    // is below the default quorum_floor of 3.
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1); // past commit_deadline
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1); // past reveal_deadline
    client.finalize_case(&case_id);
    let case_after_finalize = client.get_case(&case_id).unwrap();
    assert_eq!(case_after_finalize.status, CaseStatus::NoQuorumEscalated);

    // Mutate the active pool in between draws: deregister a juror who *was*
    // seated on committee1 (not the benched one) — this is the pool change
    // the re-draw must observe. deregister_juror's first call only flips
    // `is_active = false` (it doesn't require the cooldown to have elapsed),
    // which is exactly the flag `select_jurors` filters active jurors on.
    let leaving = committee1.get(0).unwrap();
    client.deregister_juror(&leaving);

    let juror_info = client.get_juror(&leaving).unwrap();
    assert!(
        !juror_info.is_active,
        "deregister_juror's first call must flip is_active off"
    );

    // Round 2 (the one allowed retry): the active pool is now exactly
    // {committee1 \ {leaving}} ∪ {benched} — 5 addresses, i.e. exactly
    // committee_size. select_jurors's shuffle-then-take-N over a pool of
    // exactly N active jurors deterministically seats all of them.
    client.select_jurors(&case_id);
    let case_after_draw2 = client.get_case(&case_id).unwrap();
    assert_eq!(case_after_draw2.retry_count, 2);
    assert_eq!(case_after_draw2.status, CaseStatus::CommitReveal);
    let committee2 = case_after_draw2.jurors;
    assert_eq!(committee2.len(), 5);

    // The core #52/#1167 regression check: the re-draw must never reuse a
    // juror that went inactive after the previous draw.
    assert!(
        !committee2.contains(&leaving),
        "select_jurors re-draw must not reuse a juror deregistered since the last draw"
    );

    // And it must actually reflect the pool change by pulling in the juror
    // that was benched (not deregistered) on the first draw.
    assert!(
        committee2.contains(&benched),
        "select_jurors re-draw must draw from the current active pool, including a \
         juror who was benched (not deregistered) on the previous draw"
    );

    // Every remaining (non-leaving) member of committee1 must still be
    // present, since the resulting active pool is exactly committee_size.
    for juror in committee1.iter() {
        if juror != leaving {
            assert!(
                committee2.contains(&juror),
                "an active juror from committee1 unexpectedly dropped from the re-draw"
            );
        }
    }
}

/// A pool shrinking below `committee_size` between draws (rather than just
/// changing membership) must still be rejected with `NotEnoughActiveJurors`
/// — the re-draw path shares the same active-pool-size gate as the first
/// draw, it isn't skipped just because `retry_count > 0`.
#[test]
fn test_select_jurors_redraw_fails_when_pool_shrinks_below_committee_size() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, stake_token, min_stake) = setup(&env);
    let invoice_id = client.get_invoice_contract().unwrap();

    // Register exactly committee_size (5) jurors — no slack.
    let mut jurors: Vec<Address> = Vec::new(&env);
    for _ in 0..5 {
        let operator = Address::generate(&env);
        mint(&env, &stake_token, &operator, min_stake);
        client.register_juror(&operator, &min_stake);
        jurors.push_back(operator);
    }

    let claimant = Address::generate(&env);
    let respondent = Address::generate(&env);
    let case_id = client.open_case(&invoice_id, &2u64, &claimant, &respondent, &5_000i128);

    env.ledger()
        .with_mut(|l| l.timestamp += 3 * 24 * 60 * 60 + 1);
    client.select_jurors(&case_id);

    // No-quorum finalize.
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);
    client.finalize_case(&case_id);
    assert_eq!(
        client.get_case(&case_id).unwrap().status,
        CaseStatus::NoQuorumEscalated
    );

    // Shrink the pool below committee_size before the re-draw.
    let leaving = jurors.get(0).unwrap();
    client.deregister_juror(&leaving);

    let result = client.try_select_jurors(&case_id);
    assert_eq!(result, Err(Ok(ArbitrationError::NotEnoughActiveJurors)));

    // The case must remain exactly as it was — no partial mutation from the
    // rejected re-draw attempt.
    let case = client.get_case(&case_id).unwrap();
    assert_eq!(case.status, CaseStatus::NoQuorumEscalated);
    assert_eq!(case.retry_count, 1);
}
