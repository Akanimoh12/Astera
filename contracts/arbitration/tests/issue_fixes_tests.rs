#![cfg(test)]

use arbitration::{
    ArbitrationContract, ArbitrationContractClient, ArbitrationError, CaseStatus, DisputeResolution,
};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token, Address, Env, String,
};

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

fn setup(
    env: &Env,
) -> (
    ArbitrationContractClient<'_>,
    Address,
    Address,
    Address,
    i128,
) {
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
    (client, admin, stake_token, invoice_id, min_stake)
}

fn mint(env: &Env, token_id: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token_id).mint(to, &amount);
}

#[test]
fn test_issue_1158_duplicate_open_case_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _stake_token, invoice_id, _min_stake) = setup(&env);

    let claimant = Address::generate(&env);
    let respondent = Address::generate(&env);
    let case_id = client.open_case(&invoice_id, &42u64, &claimant, &respondent, &10_000i128);

    // Attempting to open another case on the same invoice while case_id is still open fails
    let dup_res = client.try_open_case(&invoice_id, &42u64, &claimant, &respondent, &5_000i128);
    assert_eq!(dup_res, Err(Ok(ArbitrationError::DuplicateOpenCase)));

    // Fast-forward past evidence window and trigger no-quorum escalation then admin resolve
    env.ledger()
        .with_mut(|l| l.timestamp += 3 * 24 * 60 * 60 + 1);
    let mut jurors = soroban_sdk::Vec::new(&env);
    let stake_token = client.get_config().stake_token;
    for _ in 0..5 {
        let operator = Address::generate(&env);
        mint(&env, &stake_token, &operator, 2_000);
        client.register_juror(&operator, &2_000);
        jurors.push_back(operator);
    }
    client.select_jurors(&case_id);
    env.ledger()
        .with_mut(|l| l.timestamp += 4 * 24 * 60 * 60 + 2);
    client.finalize_case(&case_id); // NoQuorumEscalated retry_count=1
    client.select_jurors(&case_id); // retry_count=2
    env.ledger()
        .with_mut(|l| l.timestamp += 4 * 24 * 60 * 60 + 2);
    client.finalize_case(&case_id); // NoQuorumEscalated retry_count=2 (exhausted)

    client.admin_resolve_no_quorum(&admin, &case_id, &DisputeResolution::InFavorOfDebtor);
    assert_eq!(
        client.get_case(&case_id).unwrap().status,
        CaseStatus::Resolved
    );

    // Now that the prior case is Resolved, opening a new case for the same invoice_id succeeds!
    let new_case_id = client.open_case(&invoice_id, &42u64, &claimant, &respondent, &15_000i128);
    assert_ne!(case_id, new_case_id);
}

#[test]
fn test_issue_1159_deregister_not_blocked_by_stale_redraw_cases() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, stake_token, invoice_id, min_stake) = setup(&env);

    // Register 6 jurors so 1 will be left out on committee redraw
    let mut jurors = soroban_sdk::Vec::new(&env);
    for _ in 0..6 {
        let operator = Address::generate(&env);
        mint(&env, &stake_token, &operator, min_stake * 2);
        client.register_juror(&operator, &(min_stake * 2));
        jurors.push_back(operator);
    }

    let claimant = Address::generate(&env);
    let respondent = Address::generate(&env);
    let case_id = client.open_case(&invoice_id, &100u64, &claimant, &respondent, &10_000i128);

    env.ledger()
        .with_mut(|l| l.timestamp += 3 * 24 * 60 * 60 + 1);
    client.select_jurors(&case_id);

    let case_draw1 = client.get_case(&case_id).unwrap();

    // Advance deadlines to reach no quorum
    env.ledger()
        .with_mut(|l| l.timestamp += 4 * 24 * 60 * 60 + 2);
    client.finalize_case(&case_id); // NoQuorumEscalated

    // Re-draw committee
    client.select_jurors(&case_id);
    let case_draw2 = client.get_case(&case_id).unwrap();

    // Find a juror who was selected in draw 1 but NOT selected in draw 2
    let mut juror_dropped_in_draw2 = None;
    for j in case_draw1.jurors.iter() {
        if !case_draw2.jurors.contains(&j) {
            juror_dropped_in_draw2 = Some(j);
            break;
        }
    }

    // If one exists, verify that juror can request deregistration while case is in CommitReveal status
    if let Some(stale_juror) = juror_dropped_in_draw2 {
        let dreg_res = client.try_deregister_juror(&stale_juror);
        assert!(dreg_res.is_ok());
    }
}

#[test]
fn test_issue_1160_select_jurors_filters_understaked_jurors() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, stake_token, invoice_id, min_stake) = setup(&env);

    let mut jurors = soroban_sdk::Vec::new(&env);
    for _ in 0..5 {
        let operator = Address::generate(&env);
        mint(&env, &stake_token, &operator, min_stake);
        client.register_juror(&operator, &min_stake);
        jurors.push_back(operator);
    }

    let claimant = Address::generate(&env);
    let respondent = Address::generate(&env);
    let case_id = client.open_case(&invoice_id, &200u64, &claimant, &respondent, &10_000i128);

    env.ledger()
        .with_mut(|l| l.timestamp += 3 * 24 * 60 * 60 + 1);
    client.select_jurors(&case_id); // draw 1

    // Non-reveal will slash all 5 jurors by 3% (bringing 1000 down to 970 < 1000 min_stake)
    env.ledger()
        .with_mut(|l| l.timestamp += 4 * 24 * 60 * 60 + 2);
    client.finalize_case(&case_id);

    // Now all 5 jurors have stake 970 < 1000. Attempting to select_jurors for redraw fails due to NotEnoughActiveJurors!
    let redraw_res = client.try_select_jurors(&case_id);
    assert_eq!(redraw_res, Err(Ok(ArbitrationError::NotEnoughActiveJurors)));
}

#[test]
fn test_issue_1162_submit_evidence_caps_hash_len_and_entry_count() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _stake_token, invoice_id, _min_stake) = setup(&env);

    let claimant = Address::generate(&env);
    let respondent = Address::generate(&env);
    let case_id = client.open_case(&invoice_id, &300u64, &claimant, &respondent, &10_000i128);

    // Test evidence_hash too long (> 256 chars)
    let long_hash = String::from_str(&env, &"a".repeat(257));
    let len_res = client.try_submit_evidence(&case_id, &claimant, &long_hash);
    assert_eq!(len_res, Err(Ok(ArbitrationError::EvidenceHashTooLong)));

    // Test max 20 evidence entries cap
    let valid_hash = String::from_str(&env, "ipfs://QmValidHash");
    for _ in 0..20 {
        client.submit_evidence(&case_id, &claimant, &valid_hash);
    }
    let cap_res = client.try_submit_evidence(&case_id, &claimant, &valid_hash);
    assert_eq!(cap_res, Err(Ok(ArbitrationError::EvidenceLimitReached)));
}
