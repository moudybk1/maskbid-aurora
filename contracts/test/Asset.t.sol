// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {MaskBidAsset} from "../src/MaskBidAsset.sol";
import {ParticipantRegistry} from "../src/ParticipantRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract AssetTest is BaseTest {
    function test_RegisterRequiresEligibility() public {
        vm.prank(stranger);
        vm.expectRevert(MaskBidAsset.NotEligible.selector);
        asset.registerAsset("https://example.invalid/a.json", keccak256("a"));
        vm.prank(seller);
        vm.expectRevert(MaskBidAsset.InvalidMetadata.selector);
        asset.registerAsset("", keccak256("a"));
        vm.prank(seller);
        uint256 id = asset.registerAsset("https://example.invalid/a.json", keccak256("a"));
        assertEq(id, 1);
        assertEq(asset.uri(id), "https://example.invalid/a.json");
    }

    function test_VerifyRoleAndSelfVerify() public {
        vm.prank(seller);
        uint256 id = asset.registerAsset("https://example.invalid/a.json", keccak256("a"));
        bytes32 role = asset.VERIFIER_ROLE();
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, seller, role));
        asset.verifyAndMint(id, keccak256("r"));

        // a verifier who is also the issuer still cannot self-verify
        vm.prank(admin);
        asset.grantRole(role, seller);
        vm.prank(seller);
        vm.expectRevert(MaskBidAsset.ReviewerIsIssuer.selector);
        asset.verifyAndMint(id, keccak256("r"));

        vm.prank(verifier);
        asset.verifyAndMint(id, keccak256("r"));
        assertEq(asset.balanceOf(seller, id), 1);
        vm.prank(verifier);
        vm.expectRevert(MaskBidAsset.WrongState.selector);
        asset.verifyAndMint(id, keccak256("r"));
    }

    function test_RejectIsTerminal() public {
        vm.prank(seller);
        uint256 id = asset.registerAsset("https://example.invalid/a.json", keccak256("a"));
        vm.prank(verifier);
        asset.rejectAsset(id, keccak256("reason"));
        vm.prank(verifier);
        vm.expectRevert(MaskBidAsset.WrongState.selector);
        asset.verifyAndMint(id, keccak256("r"));
        assertEq(asset.balanceOf(seller, id), 0);
    }

    function test_RedeemOnlyByHolderOutsideEscrow() public {
        (uint256 auctionId, uint256 tokenId) = createDemoAuction();
        vm.prank(seller);
        vm.expectRevert(MaskBidAsset.NotHolder.selector);
        asset.redeem(tokenId);
        vm.prank(seller);
        auction.cancelAuction(auctionId);
        vm.prank(seller);
        auction.claimReturnedAsset(auctionId, seller);
        vm.prank(seller);
        asset.redeem(tokenId);
        assertEq(asset.balanceOf(seller, tokenId), 0);
        assertTrue(asset.getAsset(tokenId).redeemed);
        vm.prank(seller);
        vm.expectRevert(MaskBidAsset.AlreadyRedeemed.selector);
        asset.redeem(tokenId);
    }

    function test_RegistryBindings() public {
        address fresh = makeAddr("fresh");
        bytes32 uid = keccak256("human-1");
        vm.startPrank(registrar);
        registry.registerParticipant(fresh, uid, uint64(vm.getBlockTimestamp() + 1 days), 2, keccak256("p"));
        vm.expectRevert(ParticipantRegistry.UniquenessBound.selector);
        registry.registerParticipant(stranger, uid, uint64(vm.getBlockTimestamp() + 1 days), 2, keccak256("p"));
        vm.expectRevert(ParticipantRegistry.UniquenessBound.selector);
        registry.registerParticipant(fresh, keccak256("human-2"), uint64(vm.getBlockTimestamp() + 1 days), 2, keccak256("p"));
        vm.expectRevert(ParticipantRegistry.InvalidValidity.selector);
        registry.registerParticipant(fresh, uid, uint64(vm.getBlockTimestamp() + 31 days), 2, keccak256("p"));
        vm.stopPrank();
        assertTrue(registry.isEligible(fresh));
        vm.warp(vm.getBlockTimestamp() + 2 days);
        assertFalse(registry.isEligible(fresh));

        ParticipantRegistry strict = new ParticipantRegistry(admin, registrar, false);
        vm.prank(registrar);
        vm.expectRevert(ParticipantRegistry.InvalidAssurance.selector);
        strict.registerParticipant(fresh, uid, uint64(vm.getBlockTimestamp() + 1 days), 2, keccak256("p"));
    }
}
