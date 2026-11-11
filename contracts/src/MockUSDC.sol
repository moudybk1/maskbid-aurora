// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only 6-decimal payment token. Not real money.
contract MockUSDC is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;

    constructor() ERC20("Mock USDC (MaskBid testnet)", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(address to) external {
        _mint(to, FAUCET_AMOUNT);
    }
}
