// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ParticipantRegistry} from "../src/ParticipantRegistry.sol";
import {MaskBidAsset} from "../src/MaskBidAsset.sol";
import {MaskBidAuction} from "../src/MaskBidAuction.sol";
import {Protocol} from "../src/Protocol.sol";

/// @notice Deploys the four contracts and writes deployments/<chainId>.json.
/// Env: PROFILE (demo|normal), SOLVER_CODE_HASH, NEAR_ADAPTER_ACCOUNT, VERIFIER, REGISTRAR, ALLOW_SIMULATOR (bool),
/// SEED_LOCAL (bool: register+fund Anvil accounts for demos).
/// CALLBACK_SENDER is derived from NEAR_ADAPTER_ACCOUNT (engine implicit address) unless set explicitly (local mock).
/// XCC_PRECOMPILE defaults to the Aurora precompile on Aurora chain ids and to zero (dispatch off) elsewhere; XCC_GAS
/// defaults to 200 Tgas.
contract Deploy is Script {
    function run() external {
        string memory profile = vm.envOr("PROFILE", string("demo"));
        bool demo = keccak256(bytes(profile)) == keccak256("demo");
        address deployer = msg.sender;

        MaskBidAuction.Params memory p;
        p.admin = vm.envOr("ADMIN", deployer);
        p.nearAdapterAccount = vm.envOr("NEAR_ADAPTER_ACCOUNT", string("local-mock-adapter"));
        p.callbackSender = vm.envOr("CALLBACK_SENDER", address(0));
        if (p.callbackSender == address(0)) p.callbackSender = Protocol.implicitAuroraAddress(p.nearAdapterAccount);
        bool aurora = block.chainid == 1313161554 || block.chainid == 1313161555;
        p.xccPrecompile = vm.envOr("XCC_PRECOMPILE", aurora ? 0x516Cded1D16af10CAd47D6D49128E2eB7d27b372 : address(0));
        p.xccGas = uint64(vm.envOr("XCC_GAS", uint256(200_000_000_000_000)));
        p.solverCodeHash = vm.envBytes32("SOLVER_CODE_HASH");
        p.profile = profile;
        p.maxBids = 32;
        p.minDurationSeconds = demo ? 180 : 3600;
        p.maxDurationSeconds = demo ? 86_400 : 604_800;
        p.claimWindowSeconds = demo ? 300 : 172_800;
        p.settlementGraceSeconds = 1800;
        p.attemptTimeoutSeconds = 240;
        p.maxAttempts = 3;

        vm.startBroadcast();
        MockUSDC token = new MockUSDC();
        ParticipantRegistry registry =
            new ParticipantRegistry(p.admin, vm.envOr("REGISTRAR", deployer), vm.envOr("ALLOW_SIMULATOR", true));
        MaskBidAsset asset = new MaskBidAsset(p.admin, vm.envOr("VERIFIER", deployer), registry);
        p.paymentToken = address(token);
        p.assetContract = address(asset);
        p.participantRegistry = address(registry);
        MaskBidAuction auction = new MaskBidAuction(p);

        if (vm.envOr("SEED_LOCAL", false)) _seedLocal(registry, token, auction);
        vm.stopBroadcast();

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "auction", address(auction));
        vm.serializeAddress(o, "asset", address(asset));
        vm.serializeAddress(o, "registry", address(registry));
        vm.serializeAddress(o, "token", address(token));
        vm.serializeAddress(o, "callbackSender", p.callbackSender);
        vm.serializeString(o, "nearAdapterAccount", p.nearAdapterAccount);
        vm.serializeAddress(o, "xccPrecompile", p.xccPrecompile);
        vm.serializeBytes32(o, "solverCodeHash", p.solverCodeHash);
        vm.serializeBytes32(o, "configHash", auction.configHash());
        vm.serializeString(o, "profile", profile);
        vm.serializeUint(o, "deployBlock", block.number);
        string memory json = vm.serializeAddress(o, "deployer", deployer);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console.log("auction", address(auction));
        console.log("configHash");
        console.logBytes32(auction.configHash());
    }

    /// @dev Anvil default accounts 0..5 become simulated participants with mUSDC. Local only.
    function _seedLocal(ParticipantRegistry registry, MockUSDC token, MaskBidAuction) private {
        address[6] memory anvil = [
            0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
            0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,
            0x90F79bf6EB2c4f870365E785982E1f101E93b906,
            0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65,
            0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
        ];
        for (uint256 i = 0; i < anvil.length; i++) {
            registry.registerParticipant(
                anvil[i],
                keccak256(abi.encode("anvil-simulator", anvil[i])),
                uint64(block.timestamp + 30 days),
                registry.ASSURANCE_SIMULATOR(),
                keccak256("simulated-proof")
            );
            token.faucet(anvil[i]);
        }
    }
}
