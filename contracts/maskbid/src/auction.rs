//! Auction lifecycle and exits (spec 05). Tokens move only through NEP-141: a bid is `ft_transfer_call` of exactly
//! the auction's deposit with `{"action":"bid","auction_id":1,"envelope":"0x.."}`; the winner pays the remainder
//! with `{"action":"claim","auction_id":1}`. Anything this contract refuses panics, and the token refunds the sender.
//! Attach 100 Tgas to those transfers and to the exits that pay out: the payout and its fallback run inside them.
use crate::protocol::{bid_hash, envelope_header_valid, initial_digest, next_digest};
use crate::*;
use near_sdk::{Gas, Promise};

const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const PAID_GAS: Gas = Gas::from_tgas(5);
use AuctionState::*;

#[near]
impl MaskBid {
    /// Escrows the caller's verified unit and consumes their prepared key. `start_time` 0 means "now".
    pub fn create_auction(&mut self, token_id: String, reserve_units: U128, deposit_units: U128, start_time: u64, end_time: u64, key_id: String) -> u64 {
        require!(!self.entry_paused, "EntryPaused");
        let seller = env::predecessor_account_id();
        require!(self.eligible(&seller), "NotEligible");
        let (reserve, deposit) = (reserve_units.0, deposit_units.0);
        require!(deposit > 0 && reserve >= deposit, "InvalidDeposit");
        let t = now();
        let start_time = if start_time == 0 { t } else { start_time };
        require!(start_time >= t && end_time > start_time, "InvalidDuration");
        require!((self.min_duration..=self.max_duration).contains(&(end_time - start_time)), "InvalidDuration");

        let kid = h256(&key_id);
        let krid = *self.key_request_of_key_id.get(&kid).unwrap_or_else(|| env::panic_str("KeyNotReady"));
        let k = self.keys.get_mut(&krid).unwrap_or_else(|| env::panic_str("KeyNotReady"));
        require!(k.status != KeyStatus::Consumed, "KeyAlreadyConsumed");
        require!(k.status == KeyStatus::Ready && k.owner == seller, "KeyNotReady");
        k.status = KeyStatus::Consumed;

        let asset = self.assets.get(&token_id).unwrap_or_else(|| env::panic_str("AssetNotVerified"));
        require!(asset.status == AssetStatus::Verified && !asset.redeemed, "AssetNotVerified");
        require!(asset.owner.as_ref() == Some(&seller), "NotHolder");

        self.auction_count += 1;
        let auction_id = self.auction_count;
        let bid_digest = initial_digest(&self.domain(), auction_id, &kid);
        emit(
            "auction_created",
            json!({
                "auctionId": auction_id, "tokenId": token_id, "seller": seller, "reserveUnits": reserve_units, "depositUnits": deposit_units,
                "startTime": start_time, "endTime": end_time, "keyId": hex0x(&kid), "configHash": hex0x(&self.config_hash),
            }),
        );
        self.move_asset(&token_id, &env::current_account_id());
        self.auctions.insert(
            auction_id,
            Auction {
                token_id,
                seller,
                reserve_units: reserve,
                deposit_units: deposit,
                start_time,
                end_time,
                state: Created,
                key_id: kid,
                bid_count: 0,
                bid_digest,
                settlement_deadline: end_time + SETTLEMENT_GRACE,
                active_request_id: [0u8; 32],
                active_attempt: 0,
                attempt_started_at: 0,
                attempt_failed: false,
                winner: None,
                winning_amount_units: 0,
                claim_deadline: 0,
                cancel_reason: CancelReason::None,
                returned_asset_claimed: false,
                output_hash: None,
                last_error: None,
            },
        );
        auction_id
    }

    pub fn activate_auction(&mut self, auction_id: u64) {
        let mut a = self.auction(auction_id);
        require!(a.state == Created, "WrongState");
        require!(now() >= a.start_time, "AuctionNotStarted");
        require!(now() < a.end_time, "AuctionClosed");
        a.state = Active;
        emit("auction_activated", json!({ "auctionId": auction_id, "timestamp": now() }));
        self.auctions.insert(auction_id, a);
    }

    /// NEP-141 receiver: the only way tokens enter. Keeps the whole amount or panics (the token then refunds it).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(env::predecessor_account_id() == self.token, "UnexpectedToken");
        let m: Value = near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("InvalidMessage"));
        let auction_id = m["auction_id"].as_u64().unwrap_or_else(|| env::panic_str("InvalidMessage"));
        match m["action"].as_str() {
            Some("bid") => {
                let envelope = m["envelope"].as_str().and_then(|e| hex::decode(e.trim_start_matches("0x")).ok());
                self.place_bid(auction_id, sender_id, amount.0, envelope.unwrap_or_else(|| env::panic_str("InvalidEnvelopeLength")))
            }
            Some("claim") => self.settle_claim(auction_id, &sender_id, amount.0),
            _ => env::panic_str("InvalidMessage"),
        }
        U128(0)
    }

    pub fn end_auction(&mut self, auction_id: u64) {
        let mut a = self.auction(auction_id);
        if a.state == Ended {
            return;
        }
        require!(matches!(a.state, Created | Active), "WrongState");
        require!(now() >= a.end_time, "AuctionNotEnded");
        a.state = Ended;
        emit("auction_ended", json!({ "auctionId": auction_id, "timestamp": now() }));
        self.auctions.insert(auction_id, a);
    }

    // ---------------------------------------------------------------- exits

    /// For a winning amount equal to the deposit, where nothing is left to pay. Otherwise pay the remainder with
    /// `ft_transfer_call` and `{"action":"claim"}`: the unit moves to the winner in the same call.
    pub fn claim_win(&mut self, auction_id: u64) {
        self.settle_claim(auction_id, &env::predecessor_account_id(), 0)
    }

    pub fn claim_refund(&mut self, auction_id: u64) {
        let bidder = env::predecessor_account_id();
        let a = self.auction(auction_id);
        match a.state {
            PendingClaim | Finalized => require!(a.winner.as_ref() != Some(&bidder), "NotRefundable"),
            Cancelled => {}
            _ => env::panic_str("WrongState"),
        }
        self.release_deposit(auction_id, &a, &bidder, DepositStatus::Refunded, "AlreadyRefunded");
        emit("deposit_refunded", json!({ "auctionId": auction_id, "bidder": bidder, "amount": U128(a.deposit_units) }));
        self.pay(&bidder, a.deposit_units);
    }

    /// After the claim window: the winner's deposit is forfeited to the seller as a credit and the auction is cancelled.
    pub fn expire_claim(&mut self, auction_id: u64) {
        let mut a = self.auction(auction_id);
        require!(a.state == PendingClaim, "WrongState");
        require!(now() >= a.claim_deadline, "ClaimWindowOpen");
        let winner = a.winner.clone().unwrap_or_else(|| env::panic_str("WrongState"));
        self.release_deposit(auction_id, &a, &winner, DepositStatus::Forfeited, "WrongState");
        self.credit(&a.seller, a.deposit_units);
        a.state = Cancelled;
        a.cancel_reason = CancelReason::WinnerDefault;
        emit("winner_defaulted", json!({ "auctionId": auction_id, "winner": winner, "seller": a.seller, "penalty": U128(a.deposit_units) }));
        emit("auction_cancelled", json!({ "auctionId": auction_id, "reason": a.cancel_reason }));
        self.auctions.insert(auction_id, a);
    }

    pub fn cancel_auction(&mut self, auction_id: u64) {
        let mut a = self.auction(auction_id);
        require!(env::predecessor_account_id() == a.seller, "NotSeller");
        require!(matches!(a.state, Created | Active | Ended) && a.bid_count == 0 && a.active_attempt == 0, "WrongState");
        self.cancel(auction_id, &mut a, CancelReason::SellerCancelled);
    }

    /// Anyone, once the settlement deadline passed without a result: deposits and the unit become claimable again.
    pub fn cancel_after_solver_timeout(&mut self, auction_id: u64) {
        let mut a = self.auction(auction_id);
        require!(matches!(a.state, Created | Active | Ended), "WrongState");
        require!(now() >= a.settlement_deadline, "DeadlineNotReached");
        self.cancel(auction_id, &mut a, CancelReason::SolverTimeout);
    }

    pub fn claim_returned_asset(&mut self, auction_id: u64) {
        let mut a = self.auction(auction_id);
        require!(a.state == Cancelled, "WrongState");
        require!(env::predecessor_account_id() == a.seller, "NotSeller");
        require!(!a.returned_asset_claimed, "AlreadyClaimed");
        a.returned_asset_claimed = true;
        self.move_asset(&a.token_id, &a.seller);
        emit("returned_asset_claimed", json!({ "auctionId": auction_id, "seller": a.seller }));
        self.auctions.insert(auction_id, a);
    }

    pub fn withdraw_credit(&mut self) {
        let account = env::predecessor_account_id();
        let amount = self.credits.remove(&account).unwrap_or(0);
        require!(amount > 0, "NothingToWithdraw");
        self.total_credits -= amount;
        emit("credit_withdrawn", json!({ "account": account, "amount": U128(amount) }));
        self.pay(&account, amount);
    }

    /// A payout that did not arrive (receiver not registered on the token, for one) stays owed as a credit.
    #[private]
    pub fn on_paid(&mut self, account: AccountId, amount: U128) -> bool {
        let ok = near_sdk::is_promise_success();
        if !ok {
            self.credit(&account, amount.0);
            emit("payout_failed", json!({ "account": account, "amount": amount }));
        }
        ok
    }

    // ---------------------------------------------------------------- views

    pub fn get_auction(&self, auction_id: u64) -> Option<Value> {
        self.auctions.get(&auction_id).map(|a| {
            json!({
                "auctionId": auction_id, "tokenId": a.token_id, "seller": a.seller, "reserveUnits": U128(a.reserve_units),
                "depositUnits": U128(a.deposit_units), "startTime": a.start_time, "endTime": a.end_time, "state": a.state,
                "keyId": hex0x(&a.key_id), "bidCount": a.bid_count, "bidDigest": hex0x(&a.bid_digest),
                "settlementDeadline": a.settlement_deadline, "activeRequestId": hex0x(&a.active_request_id),
                "activeAttempt": a.active_attempt, "attemptStartedAt": a.attempt_started_at, "attemptFailed": a.attempt_failed,
                "winner": a.winner, "winningAmountUnits": U128(a.winning_amount_units), "claimDeadline": a.claim_deadline,
                "cancelReason": a.cancel_reason, "returnedAssetClaimed": a.returned_asset_claimed,
                "outputSha256": a.output_hash.map(|h| hex0x(&h)), "lastError": a.last_error,
            })
        })
    }

    /// Lots from `from_id` on (ids start at 1), each with its asset: a catalogue page in one call.
    pub fn get_auctions(&self, from_id: Option<u64>, limit: Option<u64>) -> Vec<Value> {
        (from_id.unwrap_or(1).max(1)..=self.auction_count)
            .take(limit.unwrap_or(50) as usize)
            .filter_map(|id| {
                let mut lot = self.get_auction(id)?;
                lot["asset"] = json!(self.get_asset(lot["tokenId"].as_str()?.to_string()));
                Some(lot)
            })
            .collect()
    }

    /// Every bid of one account, as (auction, bid index, deposit status).
    // ponytail: walks every auction; index bids by account if one deployment ever holds thousands of lots.
    pub fn get_bids_of(&self, account: AccountId) -> Vec<Value> {
        (1..=self.auction_count)
            .filter_map(|id| {
                let index = self.get_bid_index(id, account.clone())?;
                let bid = self.bids.get(&(id, index)).filter(|b| b.bidder == account)?;
                Some(json!({ "auctionId": id, "bidIndex": index, "depositStatus": bid.deposit_status }))
            })
            .collect()
    }

    pub fn get_bid(&self, auction_id: u64, bid_index: u32) -> Option<Value> {
        self.bids.get(&(auction_id, bid_index)).map(|b| {
            json!({
                "bidIndex": bid_index, "bidder": b.bidder, "bidderAddress": hex0x(&addr(b.bidder.as_str())), "identityId": hex0x(&b.identity_id),
                "commitment": hex0x(&b.commitment), "envelope": hex0x(&b.envelope), "depositStatus": b.deposit_status,
            })
        })
    }

    pub fn get_bid_index(&self, auction_id: u64, account: AccountId) -> Option<u32> {
        self.bid_index.get(&(auction_id, addr(account.as_str()))).copied()
    }

    pub fn get_credit(&self, account: AccountId) -> U128 {
        U128(self.credits.get(&account).copied().unwrap_or(0))
    }

    pub fn is_refundable(&self, auction_id: u64, account: AccountId) -> bool {
        let (Some(a), Some(index)) = (self.auctions.get(&auction_id), self.get_bid_index(auction_id, account.clone())) else { return false };
        let locked = self.bids.get(&(auction_id, index)).map_or(false, |b| b.bidder == account && b.deposit_status == DepositStatus::Locked);
        locked && (a.state == Cancelled || (matches!(a.state, PendingClaim | Finalized) && a.winner.as_ref() != Some(&account)))
    }
}

impl MaskBid {
    pub(crate) fn auction(&self, auction_id: u64) -> Auction {
        self.auctions.get(&auction_id).cloned().unwrap_or_else(|| env::panic_str("UnknownAuction"))
    }

    fn place_bid(&mut self, auction_id: u64, bidder: AccountId, amount: u128, envelope: Vec<u8>) {
        require!(!self.entry_paused, "EntryPaused");
        let mut a = self.auction(auction_id);
        require!(matches!(a.state, Created | Active), "WrongState");
        require!(now() >= a.start_time, "AuctionNotStarted");
        require!(now() < a.end_time, "AuctionClosed");
        require!(bidder != a.seller, "SellerCannotBid");
        require!(self.eligible(&bidder), "NotEligible");
        require!(amount == a.deposit_units, "InvalidDeposit");
        let bidder_addr = addr(bidder.as_str());
        require!(!self.bid_index.contains_key(&(auction_id, bidder_addr)), "DuplicateBid");
        require!(a.bid_count < MAX_BIDS, "BidCapReached");
        require!(envelope_header_valid(&envelope), "InvalidEnvelopeLength");

        let identity_id = self.participants.get(&bidder).map(|p| p.uniqueness_id).unwrap_or_default();
        let commitment = bid_hash(&self.domain(), auction_id, &bidder_addr, &a.key_id, &envelope);
        let index = a.bid_count;
        a.bid_digest = next_digest(&a.bid_digest, index, &bidder_addr, &commitment);
        a.bid_count = index + 1;
        self.total_locked_deposits += a.deposit_units;
        if a.state == Created {
            a.state = Active;
            emit("auction_activated", json!({ "auctionId": auction_id, "timestamp": now() }));
        }
        emit(
            "bid_placed",
            json!({
                "auctionId": auction_id, "bidder": bidder, "bidderAddress": hex0x(&bidder_addr), "bidIndex": index, "identityId": hex0x(&identity_id),
                "commitment": hex0x(&commitment), "envelope": hex0x(&envelope), "newDigest": hex0x(&a.bid_digest),
            }),
        );
        self.bid_index.insert((auction_id, bidder_addr), index);
        self.bids.insert((auction_id, index), Bid { bidder, identity_id, commitment, envelope, deposit_status: DepositStatus::Locked });
        self.auctions.insert(auction_id, a);
    }

    /// `paid` is what the winner just transferred: exactly the winning amount minus the deposit already held.
    fn settle_claim(&mut self, auction_id: u64, winner: &AccountId, paid: u128) {
        let mut a = self.auction(auction_id);
        require!(a.state == PendingClaim, "WrongState");
        require!(a.winner.as_ref() == Some(winner), "NotWinner");
        require!(now() < a.claim_deadline, "DeadlinePassed");
        require!(paid == a.winning_amount_units - a.deposit_units, "InvalidPayment"); // reserve >= deposit: no underflow
        self.release_deposit(auction_id, &a, winner, DepositStatus::Consumed, "WrongState");
        a.state = Finalized;
        self.move_asset(&a.token_id, winner);
        emit("win_claimed", json!({ "auctionId": auction_id, "winner": winner, "totalPaid": U128(a.winning_amount_units) }));
        self.pay(&a.seller, a.winning_amount_units);
        self.auctions.insert(auction_id, a);
    }

    fn cancel(&mut self, auction_id: u64, a: &mut Auction, reason: CancelReason) {
        a.state = Cancelled;
        a.cancel_reason = reason;
        emit("auction_cancelled", json!({ "auctionId": auction_id, "reason": reason }));
        self.auctions.insert(auction_id, a.clone());
    }

    /// Takes a bidder's deposit out of the locked total and marks it `status`; `not_locked` if it already left.
    fn release_deposit(&mut self, auction_id: u64, a: &Auction, bidder: &AccountId, status: DepositStatus, not_locked: &str) {
        let index = self.get_bid_index(auction_id, bidder.clone()).unwrap_or_else(|| env::panic_str("NotRefundable"));
        let b = self.bids.get_mut(&(auction_id, index)).unwrap_or_else(|| env::panic_str("NotRefundable"));
        require!(&b.bidder == bidder, "NotRefundable");
        require!(b.deposit_status == DepositStatus::Locked, not_locked);
        b.deposit_status = status;
        self.total_locked_deposits -= a.deposit_units;
    }

    fn credit(&mut self, account: &AccountId, amount: u128) {
        let owed = self.credits.get(account).copied().unwrap_or(0);
        self.credits.insert(account.clone(), owed + amount);
        self.total_credits += amount;
    }

    /// State is final before this runs; `on_paid` turns a failed transfer into a credit instead of losing it.
    fn pay(&mut self, account: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let args = json!({ "receiver_id": account, "amount": U128(amount) }).to_string().into_bytes();
        Promise::new(self.token.clone())
            .function_call("ft_transfer".to_string(), args, NearToken::from_yoctonear(1), FT_TRANSFER_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(PAID_GAS).on_paid(account.clone(), U128(amount)))
            .detach();
    }
}
