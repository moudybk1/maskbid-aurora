// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {MaskBidAuction} from "../src/MaskBidAuction.sol";

contract AuctionTest is BaseTest {
    // ------------------------------------------------------------ golden path (T-DEMO-01, accounting §4)

    function test_GoldenAuction() public {
        (uint256 id, uint256 tokenId) = createDemoAuction();
        assertEq(asset.balanceOf(address(auction), tokenId), 1, "escrowed");
        bid(id, alice);
        bid(id, bob);
        bid(id, carol);
        assertEq(token.balanceOf(address(auction)), 30e6);
        assertEq(auction.totalLockedDeposits(), 30e6);
        assertEq(auction.getAuction(id).bidCount, 3);
        assertSolvent();

        closeAndRequest(id);
        deliver(result(id, alice, 150e6));
        assertEq(uint8(state(id)), uint8(MaskBidAuction.AuctionState.PendingClaim));
        assertEq(token.balanceOf(address(auction)), 30e6, "callback moves no money");

        // loser refunds before the winner pays
        vm.prank(bob);
        auction.claimRefund(id);
        assertEq(token.balanceOf(address(auction)), 20e6);
        assertEq(auction.totalLockedDeposits(), 20e6);

        uint256 sellerBefore = token.balanceOf(seller);
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        auction.claimWin(id, alice);
        assertEq(token.balanceOf(seller) - sellerBefore, 150e6, "seller receives exact bid");
        assertEq(aliceBefore - token.balanceOf(alice), 140e6, "winner pays remainder");
        assertEq(asset.balanceOf(alice, tokenId), 1, "token delivered");
        assertEq(token.balanceOf(address(auction)), 10e6);
        assertEq(auction.totalLockedDeposits(), 10e6);
        assertEq(uint8(state(id)), uint8(MaskBidAuction.AuctionState.Finalized));

        vm.prank(carol);
        auction.claimRefund(id);
        assertEq(token.balanceOf(address(auction)), 0);
        assertEq(auction.totalLockedDeposits(), 0);
        assertSolvent();

        vm.prank(carol);
        vm.expectRevert(MaskBidAuction.AlreadyRefunded.selector);
        auction.claimRefund(id);
        vm.prank(alice);
        vm.expectRevert(MaskBidAuction.NotRefundable.selector);
        auction.claimRefund(id);
    }

    function test_DepositEqualsReserve_RemainderZero() public {
        uint256 tokenId = mintVerifiedAsset(seller);
        bytes32 keyId = prepareKey(seller);
        vm.startPrank(seller);
        asset.setApprovalForAll(address(auction), true);
        uint256 id = auction.createAuction(
            tokenId, 100e6, 100e6, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 600), keyId
        );
        vm.stopPrank();
        bid(id, alice);
        closeAndRequest(id);
        deliver(result(id, alice, 100e6));
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        auction.claimWin(id, alice);
        assertEq(token.balanceOf(alice), aliceBefore, "no remainder pulled");
        assertEq(token.balanceOf(seller), 1_000e6 + 100e6);
    }

    // ------------------------------------------------------------ default, no-sale, timeout (T-CONTRACT-05/07)

    function test_WinnerDefault() public {
        (uint256 id, uint256 tokenId) = createDemoAuction();
        bid(id, alice);
        bid(id, bob);
        bid(id, carol);
        closeAndRequest(id);
        deliver(result(id, alice, 150e6));

        vm.warp(auction.getAuction(id).claimDeadline);
        vm.prank(alice);
        vm.expectRevert(MaskBidAuction.DeadlinePassed.selector);
        auction.claimWin(id, alice);

        auction.expireClaim(id);
        assertEq(uint8(state(id)), uint8(MaskBidAuction.AuctionState.Cancelled));
        assertEq(auction.getSellerCredit(seller), 10e6);
        assertEq(auction.totalLockedDeposits(), 20e6);
        assertEq(auction.totalSellerCredits(), 10e6);
        assertSolvent();

        vm.prank(alice);
        vm.expectRevert(MaskBidAuction.AlreadyRefunded.selector);
        auction.claimRefund(id);
        vm.prank(bob);
        auction.claimRefund(id);
        vm.prank(carol);
        auction.claimRefund(id);
        assertEq(token.balanceOf(address(auction)), 10e6);

        vm.prank(seller);
        auction.withdrawSellerCredit(seller);
        assertEq(token.balanceOf(address(auction)), 0);
        assertEq(token.balanceOf(seller), 1_010e6);

        vm.prank(seller);
        auction.claimReturnedAsset(id, seller);
        assertEq(asset.balanceOf(seller, tokenId), 1);
        vm.prank(seller);
        vm.expectRevert(MaskBidAuction.AlreadyClaimed.selector);
        auction.claimReturnedAsset(id, seller);
    }

    function test_NoSale() public {
        (uint256 id, uint256 tokenId) = createDemoAuction();
        bid(id, alice);
        bid(id, bob);
        closeAndRequest(id);
        deliver(result(id, address(0), 0));
        assertEq(uint8(state(id)), uint8(MaskBidAuction.AuctionState.Cancelled));
        assertEq(uint8(auction.getAuction(id).cancelReason), uint8(MaskBidAuction.CancelReason.NoValidBid));
        vm.prank(alice);
        auction.claimRefund(id);
        vm.prank(bob);
        auction.claimRefund(id);
        assertEq(token.balanceOf(address(auction)), 0);
        vm.prank(seller);
        auction.claimReturnedAsset(id, seller);
        assertEq(asset.balanceOf(seller, tokenId), 1);
    }

    function test_ZeroBidsNoSale() public {
        (uint256 id,) = createDemoAuction();
        closeAndRequest(id);
        deliver(result(id, address(0), 0));
        assertEq(uint8(state(id)), uint8(MaskBidAuction.AuctionState.Cancelled));
    }

    function test_SolverTimeout() public {
        (uint256 id,) = createDemoAuction();
        bid(id, alice);
        closeAndRequest(id);
        MaskBidAuction.SettlementResult memory r = result(id, alice, 150e6);

        vm.expectRevert(MaskBidAuction.DeadlinePassed.selector);
        auction.cancelAfterSolverTimeout(id);

        vm.warp(auction.getAuction(id).settlementDeadline);
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.DeadlinePassed.selector);
        auction.onSettlementResult(r);

        auction.cancelAfterSolverTimeout(id);
        assertEq(uint8(auction.getAuction(id).cancelReason), uint8(MaskBidAuction.CancelReason.SolverTimeout));
        vm.prank(alice);
        auction.claimRefund(id);
        assertEq(token.balanceOf(alice), 1_000e6);
        assertEq(auction.getSellerCredit(seller), 0);
    }

    function test_TimeoutWithoutAnyRequest() public {
        (uint256 id,) = createDemoAuction();
        bid(id, alice);
        vm.warp(auction.getAuction(id).settlementDeadline);
        auction.cancelAfterSolverTimeout(id);
        vm.prank(alice);
        auction.claimRefund(id);
    }

    // ------------------------------------------------------------ callback binding (T-XCC-02/03)

    function test_CallbackRejectsUntrustedSender() public {
        (uint256 id,) = createDemoAuction();
        bid(id, alice);
        closeAndRequest(id);
        MaskBidAuction.SettlementResult memory r = result(id, alice, 150e6);
        vm.prank(stranger);
        vm.expectRevert(MaskBidAuction.UntrustedCallback.selector);
        auction.onSettlementResult(r);
    }

    function test_CannotRequestBeforeEnd() public {
        (uint256 id,) = createDemoAuction();
        vm.expectRevert(MaskBidAuction.AuctionClosed.selector);
        auction.requestSettlement(id);
    }

    function test_CallbackRejectsWrongBindings() public {
        (uint256 id,) = createDemoAuction();
        bid(id, alice);
        bid(id, bob);
        closeAndRequest(id);

        MaskBidAuction.SettlementResult memory r = result(id, alice, 150e6);
        r.bidDigest = keccak256("tampered");
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.DigestMismatch.selector);
        auction.onSettlementResult(r);

        r = result(id, alice, 150e6);
        r.bidCount = 1;
        r.validBidCount = 1;
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.DigestMismatch.selector);
        auction.onSettlementResult(r);

        r = result(id, alice, 150e6);
        r.keyId = keccak256("other-key");
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.DigestMismatch.selector);
        auction.onSettlementResult(r);

        r = result(id, alice, 150e6);
        r.requestId = keccak256("other-request");
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.StaleRequest.selector);
        auction.onSettlementResult(r);

        r = result(id, stranger, 150e6);
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.InvalidWinner.selector);
        auction.onSettlementResult(r);

        r = result(id, alice, 99e6);
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.BelowReserve.selector);
        auction.onSettlementResult(r);

        r = result(id, address(0), 5e6);
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.InvalidWinner.selector);
        auction.onSettlementResult(r);

        // the valid result is accepted exactly once
        r = result(id, alice, 150e6);
        deliver(r);
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.WrongState.selector);
        auction.onSettlementResult(r);
    }

    function test_RetryInvalidatesPreviousAttempt() public {
        (uint256 id,) = createDemoAuction();
        bid(id, alice);
        closeAndRequest(id);
        MaskBidAuction.SettlementResult memory first = result(id, alice, 150e6);

        uint256 t0 = auction.getAuction(id).endTime;
        vm.expectRevert(MaskBidAuction.AttemptNotTimedOut.selector);
        auction.retrySettlement(id);
        vm.warp(t0 + 240);
        auction.retrySettlement(id);
        assertEq(auction.getAuction(id).activeAttempt, 2);

        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.StaleRequest.selector);
        auction.onSettlementResult(first);

        vm.warp(t0 + 480);
        auction.retrySettlement(id);
        vm.warp(t0 + 720);
        vm.expectRevert(MaskBidAuction.MaxAttemptsReached.selector);
        auction.retrySettlement(id);

        deliver(result(id, alice, 150e6));
        assertEq(uint8(state(id)), uint8(MaskBidAuction.AuctionState.PendingClaim));
    }

    // ------------------------------------------------------------ bid rules (T-CONTRACT-02)

    function test_BidRules() public {
        (uint256 id,) = createDemoAuction();
        bytes memory e = envelope(keccak256("x"));

        vm.prank(seller);
        vm.expectRevert(MaskBidAuction.SellerCannotBid.selector);
        auction.placeBid(id, e);

        vm.prank(stranger);
        vm.expectRevert(MaskBidAuction.NotEligible.selector);
        auction.placeBid(id, e);

        vm.prank(alice);
        vm.expectRevert(MaskBidAuction.InvalidEnvelopeLength.selector);
        auction.placeBid(id, new bytes(490));

        bid(id, alice);
        vm.prank(alice);
        vm.expectRevert(MaskBidAuction.DuplicateBid.selector);
        auction.placeBid(id, e);

        // revoked identity is blocked at entry only
        vm.prank(registrar);
        registry.revokeParticipant(bob, keccak256("why"));
        vm.prank(bob);
        vm.expectRevert(MaskBidAuction.NotEligible.selector);
        auction.placeBid(id, e);

        vm.warp(auction.getAuction(id).endTime);
        vm.prank(carol);
        vm.expectRevert(MaskBidAuction.AuctionClosed.selector);
        auction.placeBid(id, e);
        assertEq(auction.getAuction(id).bidCount, 1);
    }

    function test_BidBeforeStartAndActivate() public {
        uint256 tokenId = mintVerifiedAsset(seller);
        bytes32 keyId = prepareKey(seller);
        vm.startPrank(seller);
        asset.setApprovalForAll(address(auction), true);
        uint256 id = auction.createAuction(
            tokenId, RESERVE, DEPOSIT, uint64(vm.getBlockTimestamp() + 100), uint64(vm.getBlockTimestamp() + 700), keyId
        );
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(MaskBidAuction.AuctionNotStarted.selector);
        auction.placeBid(id, envelope(keccak256("x")));
        vm.warp(vm.getBlockTimestamp() + 100);
        auction.activateAuction(id);
        assertEq(uint8(state(id)), uint8(MaskBidAuction.AuctionState.Active));
        bid(id, alice);
    }

    function test_BidCap() public {
        MaskBidAuction small = new MaskBidAuction(demoParams(2));
        uint256 tokenId = mintVerifiedAsset(seller);
        vm.prank(seller);
        bytes32 reqId = small.prepareAuctionKey(bytes32(0));
        bytes memory spki = "spki";
        bytes32 cfg = small.configHash();
        bytes32 kid = sha256(spki);
        vm.prank(adapter);
        small.onKeyPrepared(MaskBidAuction.KeyResult(reqId, seller, kid, spki, keccak256("s"), SOLVER_HASH, cfg));
        vm.startPrank(seller);
        asset.setApprovalForAll(address(small), true);
        uint256 id = small.createAuction(
            tokenId, RESERVE, DEPOSIT, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 600), kid
        );
        vm.stopPrank();
        address[3] memory bidders = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) {
            vm.startPrank(bidders[i]);
            token.approve(address(small), DEPOSIT);
            if (i == 2) vm.expectRevert(MaskBidAuction.BidCapReached.selector);
            small.placeBid(id, envelope(keccak256(abi.encode(i))));
            vm.stopPrank();
        }
        assertEq(token.balanceOf(carol), 1_000e6, "no deposit taken on revert");
    }

    function test_EntryPauseKeepsExitsOpen() public {
        (uint256 id,) = createDemoAuction();
        bid(id, alice);
        bid(id, bob);
        vm.prank(admin);
        auction.setEntryPaused(true);
        vm.prank(carol);
        vm.expectRevert(MaskBidAuction.EntryPaused.selector);
        auction.placeBid(id, envelope(keccak256("c")));
        closeAndRequest(id);
        deliver(result(id, alice, 150e6));
        vm.prank(bob);
        auction.claimRefund(id);
        vm.prank(alice);
        auction.claimWin(id, alice);
        assertEq(uint8(state(id)), uint8(MaskBidAuction.AuctionState.Finalized));
    }

    // ------------------------------------------------------------ creation, cancel, keys (T-CONTRACT-01)

    function test_CreateRejectsBadParams() public {
        uint256 tokenId = mintVerifiedAsset(seller);
        bytes32 keyId = prepareKey(seller);
        uint64 now_ = uint64(vm.getBlockTimestamp());
        vm.startPrank(seller);
        asset.setApprovalForAll(address(auction), true);
        vm.expectRevert(MaskBidAuction.InvalidDeposit.selector);
        auction.createAuction(tokenId, 10e6, 11e6, now_, now_ + 600, keyId);
        vm.expectRevert(MaskBidAuction.InvalidDeposit.selector);
        auction.createAuction(tokenId, 10e6, 0, now_, now_ + 600, keyId);
        vm.expectRevert(MaskBidAuction.InvalidDuration.selector);
        auction.createAuction(tokenId, RESERVE, DEPOSIT, now_, now_ + 179, keyId);
        vm.expectRevert(MaskBidAuction.InvalidDuration.selector);
        auction.createAuction(tokenId, RESERVE, DEPOSIT, now_, now_ + 86_401, keyId);
        vm.expectRevert(MaskBidAuction.InvalidDuration.selector);
        auction.createAuction(tokenId, RESERVE, DEPOSIT, now_ - 1, now_ + 600, keyId);
        vm.expectRevert(MaskBidAuction.KeyNotReady.selector);
        auction.createAuction(tokenId, RESERVE, DEPOSIT, now_, now_ + 600, keccak256("unknown"));
        vm.stopPrank();

        // key belongs to seller, not alice
        vm.prank(alice);
        vm.expectRevert(MaskBidAuction.KeyNotReady.selector);
        auction.createAuction(tokenId, RESERVE, DEPOSIT, now_, now_ + 600, keyId);

        // unverified asset
        vm.prank(seller);
        uint256 pending = asset.registerAsset("https://example.invalid/p.json", keccak256("p"));
        vm.prank(seller);
        vm.expectRevert(MaskBidAuction.AssetNotVerified.selector);
        auction.createAuction(pending, RESERVE, DEPOSIT, now_, now_ + 600, keyId);

        // success, then key reuse and asset reuse fail
        vm.prank(seller);
        auction.createAuction(tokenId, RESERVE, DEPOSIT, now_, now_ + 600, keyId);
        vm.prank(seller);
        vm.expectRevert(MaskBidAuction.AssetBusy.selector);
        auction.createAuction(tokenId, RESERVE, DEPOSIT, now_, now_ + 600, keyId);
        uint256 tokenId2 = mintVerifiedAsset(seller);
        vm.prank(seller);
        vm.expectRevert(MaskBidAuction.KeyAlreadyConsumed.selector);
        auction.createAuction(tokenId2, RESERVE, DEPOSIT, now_, now_ + 600, keyId);
    }

    function test_KeyCallbackBindings() public {
        vm.prank(seller);
        bytes32 reqId = auction.prepareAuctionKey(bytes32(0));
        bytes memory spki = "spki";
        MaskBidAuction.KeyResult memory r =
            MaskBidAuction.KeyResult(reqId, seller, sha256(spki), spki, keccak256("s"), SOLVER_HASH, auction.configHash());

        vm.prank(stranger);
        vm.expectRevert(MaskBidAuction.UntrustedCallback.selector);
        auction.onKeyPrepared(r);

        r.keyId = keccak256("wrong");
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.InvalidKeyResult.selector);
        auction.onKeyPrepared(r);

        r.keyId = sha256(spki);
        r.owner = alice;
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.InvalidKeyResult.selector);
        auction.onKeyPrepared(r);

        r.owner = seller;
        r.solverCodeHash = keccak256("other-code");
        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.InvalidKeyResult.selector);
        auction.onKeyPrepared(r);

        r.solverCodeHash = SOLVER_HASH;
        vm.prank(adapter);
        auction.onKeyPrepared(r);
        assertEq(uint8(auction.getKeyByKeyId(sha256(spki)).status), uint8(MaskBidAuction.KeyStatus.Ready));

        vm.prank(adapter);
        vm.expectRevert(MaskBidAuction.WrongState.selector);
        auction.onKeyPrepared(r);
    }

    function test_SellerCancelOnlyWithoutBids() public {
        (uint256 id, uint256 tokenId) = createDemoAuction();
        vm.prank(alice);
        vm.expectRevert(MaskBidAuction.NotSeller.selector);
        auction.cancelAuction(id);
        vm.prank(seller);
        auction.cancelAuction(id);
        vm.prank(seller);
        auction.claimReturnedAsset(id, seller);
        assertEq(asset.balanceOf(seller, tokenId), 1);

        (uint256 id2,) = createDemoAuction();
        bid(id2, alice);
        vm.prank(seller);
        vm.expectRevert(MaskBidAuction.WrongState.selector);
        auction.cancelAuction(id2);
    }

    function test_ForeignTokenRejected() public {
        uint256 tokenId = mintVerifiedAsset(alice);
        vm.prank(alice);
        vm.expectRevert(MaskBidAuction.UnexpectedToken.selector);
        asset.safeTransferFrom(alice, address(auction), tokenId, 1, "");
    }

    function test_WinnerMayRouteTokenToOtherRecipient() public {
        (uint256 id, uint256 tokenId) = createDemoAuction();
        bid(id, alice);
        closeAndRequest(id);
        deliver(result(id, alice, 150e6));
        vm.prank(alice);
        vm.expectRevert(MaskBidAuction.InvalidRecipient.selector);
        auction.claimWin(id, address(auction));
        vm.prank(bob);
        vm.expectRevert(MaskBidAuction.NotWinner.selector);
        auction.claimWin(id, bob);
        vm.prank(alice);
        auction.claimWin(id, carol);
        assertEq(asset.balanceOf(carol, tokenId), 1);
    }
}
