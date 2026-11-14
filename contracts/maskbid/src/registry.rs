//! Proof-of-personhood registry (spec 05 §2). The registrar writes; every entry point reads eligibility at entry only.
use crate::*;

pub const ASSURANCE_REAL_PROVIDER: u8 = 1;
pub const ASSURANCE_SIMULATOR: u8 = 2;
pub const MAX_VALIDITY: u64 = 30 * 86_400;

#[near]
impl MaskBid {
    pub fn register_participant(&mut self, account: AccountId, uniqueness_id: String, verified_until: u64, assurance: u8, proof_digest: String) {
        self.only(&self.registrar);
        let uid = h256(&uniqueness_id);
        require!(uid != [0u8; 32], "InvalidParticipant");
        // Deployment policy: a real deployment refuses simulator assurance.
        require!(assurance == ASSURANCE_REAL_PROVIDER || (assurance == ASSURANCE_SIMULATOR && self.allow_simulator), "InvalidAssurance");
        let t = now();
        require!(verified_until > t && verified_until <= t + MAX_VALIDITY, "InvalidValidity");
        // MVP: no account rotation and no ID reassignment; renew only the same account/ID pair.
        require!(self.participants.get(&account).map_or(true, |p| p.uniqueness_id == uid), "UniquenessBound");
        require!(self.account_of_uniqueness.get(&uid).map_or(true, |a| a == &account), "UniquenessBound");
        self.account_of_uniqueness.insert(uid, account.clone());
        self.participants.insert(account.clone(), Participant { uniqueness_id: uid, verified_until, assurance, revoked: false });
        emit(
            "participant_registered",
            json!({ "account": account, "uniquenessId": hex0x(&uid), "assurance": assurance, "verifiedUntil": verified_until, "proofDigest": hex0x(&h256(&proof_digest)) }),
        );
    }

    /// Demo deployments only (`allow_simulator`): the caller registers itself with simulator assurance for 30 days.
    /// The identity is derived from the account id, so this gives one bid per account, not one per person; the
    /// assurance level says so to every reader. A revoked participant cannot re-register this way.
    pub fn register_simulated(&mut self) {
        require!(self.allow_simulator, "InvalidAssurance");
        let account = env::predecessor_account_id();
        require!(self.participants.get(&account).map_or(true, |p| !p.revoked), "Revoked");
        let uid = env::keccak256_array(format!("maskbid-simulator:{account}").as_bytes());
        require!(self.participants.get(&account).map_or(true, |p| p.uniqueness_id == uid), "UniquenessBound");
        require!(self.account_of_uniqueness.get(&uid).map_or(true, |a| a == &account), "UniquenessBound");
        let verified_until = now() + MAX_VALIDITY - 60;
        self.account_of_uniqueness.insert(uid, account.clone());
        self.participants.insert(account.clone(), Participant { uniqueness_id: uid, verified_until, assurance: ASSURANCE_SIMULATOR, revoked: false });
        emit(
            "participant_registered",
            json!({ "account": account, "uniquenessId": hex0x(&uid), "assurance": ASSURANCE_SIMULATOR, "verifiedUntil": verified_until, "proofDigest": null, "selfRegistered": true }),
        );
    }

    pub fn revoke_participant(&mut self, account: AccountId, reason_hash: String) {
        self.only(&self.registrar);
        self.participants.get_mut(&account).unwrap_or_else(|| env::panic_str("InvalidParticipant")).revoked = true;
        emit("participant_revoked", json!({ "account": account, "reasonHash": hex0x(&h256(&reason_hash)) }));
    }

    pub fn is_eligible(&self, account: AccountId) -> bool {
        self.eligible(&account)
    }

    pub fn get_participant(&self, account: AccountId) -> Option<Value> {
        self.participants.get(&account).map(|p| {
            json!({ "uniquenessId": hex0x(&p.uniqueness_id), "verifiedUntil": p.verified_until, "assurance": p.assurance, "revoked": p.revoked })
        })
    }
}

impl MaskBid {
    pub(crate) fn eligible(&self, account: &AccountId) -> bool {
        self.participants.get(account).map_or(false, |p| !p.revoked && p.verified_until > now())
    }
}
