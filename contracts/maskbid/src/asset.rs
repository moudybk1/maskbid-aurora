//! One verified unit per token id (spec 05 §3). Metadata is immutable from registration. The unit is exposed through
//! the NEP-171 core views and `nft_transfer`, with NEP-171 events, so explorers and wallets can follow it.
// ponytail: no nft_transfer_call, approvals or indexed enumeration (nft_tokens_for_owner scans every token id).
// Add them when a marketplace or a large catalogue needs them.
use crate::*;
use base64::Engine;

pub const MAX_URI_LENGTH: usize = 512;

fn nep171(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "nep171", "version": "1.0.0", "event": event, "data": [data] })));
}

#[near]
impl MaskBid {
    pub fn register_asset(&mut self, metadata_uri: String, metadata_hash: String) -> String {
        require!(!self.entry_paused, "EntryPaused");
        let issuer = env::predecessor_account_id();
        require!(self.eligible(&issuer), "NotEligible");
        let hash = h256(&metadata_hash);
        require!(!metadata_uri.is_empty() && metadata_uri.len() <= MAX_URI_LENGTH && hash != [0u8; 32], "InvalidMetadata");
        let token_id = self.next_token_id.to_string();
        self.next_token_id += 1;
        emit("asset_registered", json!({ "tokenId": token_id, "issuer": issuer, "metadataUri": metadata_uri, "metadataHash": hex0x(&hash) }));
        self.assets.insert(
            token_id.clone(),
            Asset { issuer, metadata_uri, metadata_hash: hash, status: AssetStatus::Pending, reviewer: None, review_digest: [0u8; 32], owner: None, redeemed: false },
        );
        token_id
    }

    /// The verifier never reviews their own asset. Mints exactly one unit to the issuer in the same call.
    pub fn verify_and_mint(&mut self, token_id: String, review_digest: String) {
        let digest = h256(&review_digest);
        require!(digest != [0u8; 32], "InvalidDigest");
        let reviewer = env::predecessor_account_id();
        let a = self.pending(&token_id);
        a.status = AssetStatus::Verified;
        a.reviewer = Some(reviewer.clone());
        a.review_digest = digest;
        a.owner = Some(a.issuer.clone());
        nep171("nft_mint", json!({ "owner_id": a.issuer, "token_ids": [token_id] }));
        emit("asset_verified", json!({ "tokenId": token_id, "reviewer": reviewer, "reviewDigest": hex0x(&digest) }));
    }

    pub fn reject_asset(&mut self, token_id: String, reason_hash: String) {
        let reason = h256(&reason_hash);
        let reviewer = env::predecessor_account_id();
        let a = self.pending(&token_id);
        a.status = AssetStatus::Rejected;
        a.reviewer = Some(reviewer.clone());
        emit("asset_rejected", json!({ "tokenId": token_id, "reviewer": reviewer, "reasonHash": hex0x(&reason) }));
    }

    /// Burn the unit you hold. Proves token redemption only, not physical delivery.
    pub fn redeem(&mut self, token_id: String) {
        let holder = env::predecessor_account_id();
        let a = self.assets.get_mut(&token_id).unwrap_or_else(|| env::panic_str("UnknownAsset"));
        require!(!a.redeemed, "AlreadyRedeemed");
        require!(a.owner.as_ref() == Some(&holder), "NotHolder");
        a.owner = None;
        a.redeemed = true;
        nep171("nft_burn", json!({ "owner_id": holder, "token_ids": [token_id] }));
        emit("asset_redeemed", json!({ "tokenId": token_id, "owner": holder }));
    }

    pub fn get_asset(&self, token_id: String) -> Option<Value> {
        self.assets.get(&token_id).map(|a| {
            json!({
                "tokenId": token_id, "issuer": a.issuer, "metadataUri": a.metadata_uri, "metadataHash": hex0x(&a.metadata_hash),
                "status": a.status, "reviewer": a.reviewer, "reviewDigest": hex0x(&a.review_digest), "owner": a.owner,
                "minted": a.status == AssetStatus::Verified, "redeemed": a.redeemed,
                "inEscrow": a.owner.as_ref() == Some(&env::current_account_id()),
            })
        })
    }

    /// Assets from token id `from_id` on (ids start at 1), in one call.
    pub fn get_assets(&self, from_id: Option<u64>, limit: Option<u64>) -> Vec<Value> {
        (from_id.unwrap_or(1).max(1)..self.next_token_id).take(limit.unwrap_or(100) as usize).filter_map(|id| self.get_asset(id.to_string())).collect()
    }

    // ---------------------------------------------------------------- NEP-171 / NEP-177

    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        let _ = (approval_id, memo);
        let sender = env::predecessor_account_id();
        let owner = self.assets.get(&token_id).and_then(|a| a.owner.clone()).unwrap_or_else(|| env::panic_str("UnknownAsset"));
        // A unit in escrow belongs to an auction: only the auction exits move it, never a direct transfer.
        require!(owner != env::current_account_id(), "AssetBusy");
        require!(owner == sender, "NotHolder");
        require!(receiver_id != sender && receiver_id != env::current_account_id(), "InvalidRecipient");
        self.move_asset(&token_id, &receiver_id);
    }

    pub fn nft_token(&self, token_id: String) -> Option<Value> {
        let a = self.assets.get(&token_id)?;
        let owner = a.owner.as_ref()?;
        Some(json!({
            "token_id": token_id, "owner_id": owner,
            "metadata": {
                "title": format!("MaskBid asset #{token_id}"), "reference": a.metadata_uri,
                "reference_hash": base64::engine::general_purpose::STANDARD.encode(a.metadata_hash),
            },
        }))
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Value> {
        (1..self.next_token_id)
            .map(|id| id.to_string())
            .filter(|id| self.assets.get(id).map_or(false, |a| a.owner.as_ref() == Some(&account_id)))
            .skip(from_index.map_or(0, |i| i.0 as usize))
            .take(limit.unwrap_or(50) as usize)
            .filter_map(|id| self.nft_token(id))
            .collect()
    }

    pub fn nft_metadata(&self) -> Value {
        json!({ "spec": "nft-1.0.0", "name": "MaskBid verified assets", "symbol": "MASKBID" })
    }
}

impl MaskBid {
    fn pending(&mut self, token_id: &String) -> &mut Asset {
        self.only(&self.verifier);
        let a = self.assets.get_mut(token_id).unwrap_or_else(|| env::panic_str("UnknownAsset"));
        require!(a.status == AssetStatus::Pending, "WrongState");
        require!(a.issuer != env::predecessor_account_id(), "ReviewerIsIssuer");
        a
    }

    /// Moves the unit to `to`. Callers have already checked who may move it.
    pub(crate) fn move_asset(&mut self, token_id: &String, to: &AccountId) {
        let a = self.assets.get_mut(token_id).unwrap_or_else(|| env::panic_str("UnknownAsset"));
        let from = a.owner.replace(to.clone());
        nep171("nft_transfer", json!({ "old_owner_id": from, "new_owner_id": to, "token_ids": [token_id] }));
    }
}
