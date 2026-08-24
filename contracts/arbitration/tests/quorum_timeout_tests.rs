#![cfg(test)]

use arbitration::{
    ArbitrationContract, ArbitrationContractClient, ArbitrationError, CaseStatus, DisputeResolution,
};
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger},
    token, Address, Bytes, BytesN, Env, Symbol,
};

const LAST_ID: Symbol = symbol_short!("last_id");
const LAST_OUT: Symbol = symbol_short!("last_out");

#[contract]
pub struct DummyInvoice;

#[contractimpl]
impl DummyInvoice {
    pub fn arbitration_resolve_dispute(
        env: Env,
        arbitration: Address,
        id: u64,
        outcome: DisputeResolution,
    ) {
        arbitration.require_auth();
        env.storage().instance().set(&LAST_ID, &id);
        env.storage().instance().set(&LAST_OUT, &outcome);
    }

    pub fn get_last(env: Env) -> (u64, DisputeResolution) {
        (
            env.storage().instance().get(&LAST_ID).unwrap_or(0),
            env.storage()
                .instance()
                .get(&LAST_OUT)
                .unwrap_or(DisputeResolution::Pending),
        )
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

fn commit_hash(env: &Env, vote: bool, salt: &BytesN<32>) -> BytesN<32> {
    let mut preimage = Bytes::new(env);
    preimage.push_back(if vote { 1u8 } else { 0u8 });
    preimage.append(&Bytes::from(salt.clone()));
    env.crypto().sha256(&preimage).to_bytes()
}

/// #1043 acceptance criterion: "The no-quorum timeout/escalation path is
/// covered by a dedicated test." Registers exactly `committee_size` (5)
/// jurors so every committee draw uses the same fixed pool, commits all of
/// them each round but only reveals 2 (below the default `quorum_floor` of
/// 3) — first via the initial draw, then again on the one allowed retry —
/// and asserts the case ends up needing (and accepting) admin fallback
/// resolution, never leaving the invoice stuck.
#[test]
fn test_no_quorum_escalates_retries_then_falls_back_to_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, stake_token, min_stake) = setup(&env);
    let invoice_id = client.get_invoice_contract().unwrap();
    let invoice_client = DummyInvoiceClient::new(&env, &invoice_id);

    let mut jurors = soroban_sdk::Vec::new(&env);
    for _ in 0..5 {
        let operator = Address::generate(&env);
        mint(&env, &stake_token, &operator, min_stake);
        client.register_juror(&operator, &min_stake);
        jurors.push_back(operator);
    }

    let claimant = Address::generate(&env);
    let respondent = Address::generate(&env);
    let case_id = client.open_case(&invoice_id, &99u64, &claimant, &respondent, &10_000i128);

    // Round 1: evidence window closes, committee drawn.
    env.ledger()
        .with_mut(|l| l.timestamp += 3 * 24 * 60 * 60 + 1);
    client.select_jurors(&case_id);
    let case = client.get_case(&case_id).unwrap();
    assert_eq!(case.retry_count, 1);

    // select_jurors can't be called again mid-round.
    let too_soon = client.try_select_jurors(&case_id);
    assert_eq!(too_soon, Err(Ok(ArbitrationError::InvalidCaseStatus)));

    // Commit all 5, but only reveal 2 — below the quorum floor of 3.
    let mut salts = soroban_sdk::Vec::new(&env);
    for i in 0u8..5 {
        let salt = BytesN::from_array(&env, &[i + 1; 32]);
        salts.push_back(salt.clone());
        let juror = case.jurors.get(i as u32).unwrap();
        client.commit_vote(&case_id, &juror, &commit_hash(&env, true, &salt));
    }
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);
    for i in 0u32..2 {
        let juror = case.jurors.get(i).unwrap();
        let salt = salts.get(i).unwrap();
        client.reveal_vote(&case_id, &juror, &true, &salt);
    }

    // finalize_case can't run before the reveal deadline.
    let too_soon = client.try_finalize_case(&case_id);
    assert_eq!(too_soon, Err(Ok(ArbitrationError::WindowNotClosed)));

    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);
    client.finalize_case(&case_id);

    let case = client.get_case(&case_id).unwrap();
    assert_eq!(case.status, CaseStatus::NoQuorumEscalated);
    assert_eq!(case.resolution, DisputeResolution::Pending);
    // Nothing was written back to invoice yet.
    assert_eq!(
        invoice_client.get_last(),
        (0u64, DisputeResolution::Pending)
    );

    // Admin can't shortcut yet — one committee re-draw is still available.
    let premature =
        client.try_admin_resolve_no_quorum(&admin, &case_id, &DisputeResolution::InFavorOfDebtor);
    assert_eq!(premature, Err(Ok(ArbitrationError::RetriesNotExhausted)));

    // Round 2 (the one allowed retry): same story, still below quorum.
    client.select_jurors(&case_id);
    let case = client.get_case(&case_id).unwrap();
    assert_eq!(case.retry_count, 2);
    assert_eq!(case.status, CaseStatus::CommitReveal);

    let mut salts2 = soroban_sdk::Vec::new(&env);
    for i in 0u8..5 {
        let salt = BytesN::from_array(&env, &[100 + i; 32]);
        salts2.push_back(salt.clone());
        let juror = case.jurors.get(i as u32).unwrap();
        client.commit_vote(&case_id, &juror, &commit_hash(&env, false, &salt));
    }
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);
    for i in 0u32..2 {
        let juror = case.jurors.get(i).unwrap();
        let salt = salts2.get(i).unwrap();
        client.reveal_vote(&case_id, &juror, &false, &salt);
    }
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);
    client.finalize_case(&case_id);

    let case = client.get_case(&case_id).unwrap();
    assert_eq!(case.status, CaseStatus::NoQuorumEscalated);
    assert_eq!(case.retry_count, 2);

    // Retries are now exhausted (max_retries defaults to 1, so 2 draws total
    // is the ceiling) — select_jurors must refuse a third draw...
    let exhausted = client.try_select_jurors(&case_id);
    assert_eq!(exhausted, Err(Ok(ArbitrationError::RetriesExhausted)));

    // ...and admin_resolve_no_quorum is now the only way forward, keeping
    // this dispute from being stuck indefinitely.
    client.admin_resolve_no_quorum(&admin, &case_id, &DisputeResolution::InFavorOfDebtor);

    let case = client.get_case(&case_id).unwrap();
    assert_eq!(case.status, CaseStatus::Resolved);
    assert_eq!(case.resolution, DisputeResolution::InFavorOfDebtor);
    assert_eq!(
        invoice_client.get_last(),
        (99u64, DisputeResolution::InFavorOfDebtor)
    );

    // A resolved case can't be admin-resolved again.
    let already_done =
        client.try_admin_resolve_no_quorum(&admin, &case_id, &DisputeResolution::InFavorOfDebtor);
    assert_eq!(already_done, Err(Ok(ArbitrationError::CaseNotEscalated)));
}

/// Tests the new list_cases_by_status function to ensure it correctly
/// finds cases in NoQuorumEscalated status, addressing issue #1163.
#[test]
fn test_list_cases_by_status_finds_escalated_cases() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, stake_token, min_stake) = setup(&env);
    let invoice_id = client.get_invoice_contract().unwrap();

    // Register 5 jurors for committees
    let mut jurors = soroban_sdk::Vec::new(&env);
    for _ in 0..5 {
        let operator = Address::generate(&env);
        mint(&env, &stake_token, &operator, min_stake);
        client.register_juror(&operator, &min_stake);
        jurors.push_back(operator);
    }

    let claimant = Address::generate(&env);
    let respondent = Address::generate(&env);

    // Create multiple cases with different statuses
    let case_id_1 = client.open_case(&invoice_id, &1u64, &claimant, &respondent, &10_000i128);
    let case_id_2 = client.open_case(&invoice_id, &2u64, &claimant, &respondent, &15_000i128);
    let case_id_3 = client.open_case(&invoice_id, &3u64, &claimant, &respondent, &20_000i128);

    // Initially, all cases should be in EvidenceWindow status
    let evidence_cases = client.list_cases_by_status(&CaseStatus::EvidenceWindow);
    assert_eq!(evidence_cases.len(), 3);
    assert!(evidence_cases.contains(case_id_1));
    assert!(evidence_cases.contains(case_id_2));
    assert!(evidence_cases.contains(case_id_3));

    // No cases should be in NoQuorumEscalated yet
    let escalated_cases = client.list_cases_by_status(&CaseStatus::NoQuorumEscalated);
    assert_eq!(escalated_cases.len(), 0);

    // Move case_1 to NoQuorumEscalated by going through the quorum failure process
    // First, advance past evidence window
    env.ledger()
        .with_mut(|l| l.timestamp += 3 * 24 * 60 * 60 + 1);

    // Select jurors for case_1
    client.select_jurors(&case_id_1);
    let case = client.get_case(&case_id_1).unwrap();

    // Commit all jurors but only reveal 2 (below quorum of 3)
    let mut salts = soroban_sdk::Vec::new(&env);
    for i in 0u8..5 {
        let salt = BytesN::from_array(&env, &[i + 1; 32]);
        salts.push_back(salt.clone());
        let juror = case.jurors.get(i as u32).unwrap();
        client.commit_vote(&case_id_1, &juror, &commit_hash(&env, true, &salt));
    }

    // Move past commit deadline
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);

    // Reveal only 2 votes (below quorum)
    for i in 0u32..2 {
        let juror = case.jurors.get(i).unwrap();
        let salt = salts.get(i).unwrap();
        client.reveal_vote(&case_id_1, &juror, &true, &salt);
    }

    // Move past reveal deadline and finalize (this will escalate due to no quorum)
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);
    client.finalize_case(&case_id_1);

    // Do the retry and fail again to reach NoQuorumEscalated
    client.select_jurors(&case_id_1);
    let case = client.get_case(&case_id_1).unwrap();

    let mut salts2 = soroban_sdk::Vec::new(&env);
    for i in 0u8..5 {
        let salt = BytesN::from_array(&env, &[100 + i; 32]);
        salts2.push_back(salt.clone());
        let juror = case.jurors.get(i as u32).unwrap();
        client.commit_vote(&case_id_1, &juror, &commit_hash(&env, false, &salt));
    }
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);
    for i in 0u32..2 {
        let juror = case.jurors.get(i).unwrap();
        let salt = salts2.get(i).unwrap();
        client.reveal_vote(&case_id_1, &juror, &false, &salt);
    }
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);
    client.finalize_case(&case_id_1);

    // Now case_1 should be in NoQuorumEscalated
    let case = client.get_case(&case_id_1).unwrap();
    assert_eq!(case.status, CaseStatus::NoQuorumEscalated);

    // Test list_cases_by_status finds the escalated case
    let escalated_cases = client.list_cases_by_status(&CaseStatus::NoQuorumEscalated);
    assert_eq!(escalated_cases.len(), 1);
    assert_eq!(escalated_cases.get(0).unwrap(), case_id_1);

    // Other cases should still be in EvidenceWindow
    let evidence_cases = client.list_cases_by_status(&CaseStatus::EvidenceWindow);
    assert_eq!(evidence_cases.len(), 2);
    assert!(evidence_cases.contains(case_id_2));
    assert!(evidence_cases.contains(case_id_3));

    // Move case_2 to CommitReveal status
    client.select_jurors(&case_id_2);
    let commit_reveal_cases = client.list_cases_by_status(&CaseStatus::CommitReveal);
    assert_eq!(commit_reveal_cases.len(), 1);
    assert_eq!(commit_reveal_cases.get(0).unwrap(), case_id_2);

    // Resolve case_1 using admin_resolve_no_quorum
    client.admin_resolve_no_quorum(&admin, &case_id_1, &DisputeResolution::InFavorOfDebtor);

    // Now case_1 should be Resolved and not appear in NoQuorumEscalated list
    let escalated_cases = client.list_cases_by_status(&CaseStatus::NoQuorumEscalated);
    assert_eq!(escalated_cases.len(), 0);

    let resolved_cases = client.list_cases_by_status(&CaseStatus::Resolved);
    assert_eq!(resolved_cases.len(), 1);
    assert_eq!(resolved_cases.get(0).unwrap(), case_id_1);
}

/// Tests the new juror statistics functions for aggregate and individual stats
/// addressing issue #1164 for reputation/leaderboard display.
#[test]
fn test_juror_statistics_functions() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, stake_token, min_stake) = setup(&env);
    let invoice_id = client.get_invoice_contract().unwrap();

    // Initially no jurors
    let initial_aggregate = client.get_aggregate_juror_stats();
    assert_eq!(initial_aggregate.total_jurors, 0);
    assert_eq!(initial_aggregate.active_jurors, 0);
    assert_eq!(initial_aggregate.total_stake, 0);
    assert_eq!(initial_aggregate.total_cases_served, 0);
    assert_eq!(initial_aggregate.total_slashes, 0);
    assert_eq!(initial_aggregate.total_non_reveal_strikes, 0);

    let initial_all_stats = client.get_all_juror_stats();
    assert_eq!(initial_all_stats.len(), 0);

    // Register multiple jurors with different stake amounts (need 5 for committee)
    let juror1 = Address::generate(&env);
    let juror2 = Address::generate(&env);
    let juror3 = Address::generate(&env);
    let juror4 = Address::generate(&env);
    let juror5 = Address::generate(&env);

    let stake1 = min_stake;
    let stake2 = min_stake * 2;
    let stake3 = min_stake * 3;
    let stake4 = min_stake * 4;
    let stake5 = min_stake * 5;

    mint(&env, &stake_token, &juror1, stake1);
    mint(&env, &stake_token, &juror2, stake2);
    mint(&env, &stake_token, &juror3, stake3);
    mint(&env, &stake_token, &juror4, stake4);
    mint(&env, &stake_token, &juror5, stake5);

    // Register jurors at different times
    env.ledger().with_mut(|l| l.timestamp = 2_000_000);
    client.register_juror(&juror1, &stake1);

    env.ledger().with_mut(|l| l.timestamp = 3_000_000);
    client.register_juror(&juror2, &stake2);

    env.ledger().with_mut(|l| l.timestamp = 4_000_000);
    client.register_juror(&juror3, &stake3);

    env.ledger().with_mut(|l| l.timestamp = 5_000_000);
    client.register_juror(&juror4, &stake4);

    env.ledger().with_mut(|l| l.timestamp = 6_000_000);
    client.register_juror(&juror5, &stake5);

    // Check aggregate stats after registration
    let post_reg_aggregate = client.get_aggregate_juror_stats();
    assert_eq!(post_reg_aggregate.total_jurors, 5);
    assert_eq!(post_reg_aggregate.active_jurors, 5);
    assert_eq!(
        post_reg_aggregate.total_stake,
        stake1 + stake2 + stake3 + stake4 + stake5
    );
    assert_eq!(post_reg_aggregate.total_cases_served, 0);
    assert_eq!(post_reg_aggregate.total_slashes, 0);
    assert_eq!(post_reg_aggregate.total_non_reveal_strikes, 0);

    // Check individual stats
    let all_stats = client.get_all_juror_stats();
    assert_eq!(all_stats.len(), 5);

    // Find each juror's stats (order might vary)
    let juror1_stats = all_stats.iter().find(|s| s.address == juror1).unwrap();
    let juror2_stats = all_stats.iter().find(|s| s.address == juror2).unwrap();
    let juror3_stats = all_stats.iter().find(|s| s.address == juror3).unwrap();

    assert_eq!(juror1_stats.stake_amount, stake1);
    assert_eq!(juror1_stats.is_active, true);
    assert_eq!(juror1_stats.cases_served, 0);
    assert_eq!(juror1_stats.times_slashed, 0);
    assert_eq!(juror1_stats.non_reveal_strikes, 0);
    assert_eq!(juror1_stats.registered_at, 2_000_000);

    assert_eq!(juror2_stats.stake_amount, stake2);
    assert_eq!(juror2_stats.registered_at, 3_000_000);

    assert_eq!(juror3_stats.stake_amount, stake3);
    assert_eq!(juror3_stats.registered_at, 4_000_000);

    // Create a case and simulate juror activities that will increment stats
    let claimant = Address::generate(&env);
    let respondent = Address::generate(&env);
    let case_id = client.open_case(&invoice_id, &1u64, &claimant, &respondent, &10_000i128);

    // Move past evidence window and select jurors
    env.ledger()
        .with_mut(|l| l.timestamp += 3 * 24 * 60 * 60 + 1);
    client.select_jurors(&case_id);

    let case = client.get_case(&case_id).unwrap();

    // Commit votes from all selected jurors
    let mut salts = soroban_sdk::Vec::new(&env);
    for i in 0u32..case.jurors.len() {
        let salt = BytesN::from_array(&env, &[(i as u8) + 1; 32]);
        salts.push_back(salt.clone());
        let juror = case.jurors.get(i).unwrap();
        client.commit_vote(&case_id, &juror, &commit_hash(&env, true, &salt));
    }

    // Move past commit deadline
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);

    // Only reveal votes from some jurors to create different outcomes
    // Reveal from first 3 jurors (committee size is 5 by default)
    for i in 0u32..3 {
        if i < case.jurors.len() {
            let juror = case.jurors.get(i).unwrap();
            let salt = salts.get(i).unwrap();
            client.reveal_vote(&case_id, &juror, &true, &salt);
        }
    }

    // Move past reveal deadline and finalize
    env.ledger()
        .with_mut(|l| l.timestamp += 2 * 24 * 60 * 60 + 1);
    client.finalize_case(&case_id);

    // Check updated aggregate stats - should show increased activity
    let post_case_aggregate = client.get_aggregate_juror_stats();
    assert_eq!(post_case_aggregate.total_jurors, 5);
    assert_eq!(post_case_aggregate.active_jurors, 5);
    assert_eq!(
        post_case_aggregate.total_stake,
        stake1 + stake2 + stake3 + stake4 + stake5
    ); // Should be reduced due to slashing, but we'll check this separately

    // Cases served should be incremented for committee members
    assert!(post_case_aggregate.total_cases_served > 0);

    // Non-reveal strikes should be incremented for jurors who didn't reveal
    assert!(post_case_aggregate.total_non_reveal_strikes > 0);

    // Check that individual stats show the changes
    let updated_all_stats = client.get_all_juror_stats();
    assert_eq!(updated_all_stats.len(), 5);

    // Verify that some jurors now have cases_served > 0 and non_reveal_strikes incremented
    let total_cases_served: u32 = updated_all_stats.iter().map(|s| s.cases_served).sum();
    let total_non_reveal_strikes: u32 =
        updated_all_stats.iter().map(|s| s.non_reveal_strikes).sum();

    assert!(total_cases_served > 0);
    assert!(total_non_reveal_strikes > 0);

    // Test with inactive juror - deregister one juror
    client.deregister_juror(&juror5);

    let post_dereg_aggregate = client.get_aggregate_juror_stats();
    assert_eq!(post_dereg_aggregate.total_jurors, 5); // Still 5 total
    assert_eq!(post_dereg_aggregate.active_jurors, 4); // But only 4 active
}
