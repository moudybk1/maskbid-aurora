//! Testnet-only 6-decimal payment token (NEP-141 + NEP-145 + NEP-148) with a faucet. Not real money.
//! The standard implementation from near-contract-standards, so the auction meets the same behaviour a real
//! NEP-141 has: a receiver must be registered for storage before it can hold tokens.
use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

pub const FAUCET_AMOUNT: u128 = 1_000_000_000; // 1,000 mUSDC

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockUsdc {
    token: FungibleToken,
}

#[near]
impl MockUsdc {
    #[init]
    #[private]
    pub fn new() -> Self {
        Self { token: FungibleToken::new(b"t") }
    }

    /// Mints 1,000 mUSDC to `to`, registering it first if needed (this contract pays that storage).
    pub fn faucet(&mut self, to: AccountId) {
        if !self.token.accounts.contains_key(&to) {
            self.token.internal_register_account(&to);
        }
        self.token.internal_deposit(&to, FAUCET_AMOUNT);
        FtMint { owner_id: &to, amount: U128(FAUCET_AMOUNT), memo: Some("faucet") }.emit();
    }
}

#[near]
impl FungibleTokenCore for MockUsdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }
    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }
    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }
    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockUsdc {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount).0.into()
    }
}

#[near]
impl StorageManagement for MockUsdc {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockUsdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Mock USDC (MaskBid testnet)".to_string(),
            symbol: "mUSDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    #[test]
    fn faucet_registers_and_mints() {
        testing_env!(VMContextBuilder::new().build());
        let mut t = MockUsdc::new();
        t.faucet(accounts(1));
        t.faucet(accounts(1));
        assert_eq!(t.ft_balance_of(accounts(1)).0, 2 * FAUCET_AMOUNT);
        assert_eq!(t.ft_total_supply().0, 2 * FAUCET_AMOUNT);
        assert!(t.storage_balance_of(accounts(1)).is_some() && t.storage_balance_of(accounts(2)).is_none());
    }
}
