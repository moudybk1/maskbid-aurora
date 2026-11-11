// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ParticipantRegistry} from "../src/ParticipantRegistry.sol";
import {MaskBidAsset} from "../src/MaskBidAsset.sol";
import {MaskBidAuction} from "../src/MaskBidAuction.sol";
import {Protocol} from "../src/Protocol.sol";

abstract contract BaseTest is Test {
    MockUSDC token;
    ParticipantRegistry registry;
    MaskBidAsset asset;
    MaskBidAuction auction;

    address admin = makeAddr("admin");
    address registrar = makeAddr("registrar");
    address verifier = makeAddr("verifier");
    address adapter = makeAddr("adapter"); // local callback sender
    address seller = makeAddr("seller");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address stranger = makeAddr("stranger");

    bytes32 constant SOLVER_HASH = keccak256("solver-code");
    uint256 constant RESERVE = 100e6;
    uint256 constant DEPOSIT = 10e6;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        token = new MockUSDC();
        registry = new ParticipantRegistry(admin, registrar, true);
        asset = new MaskBidAsset(admin, verifier, registry);
        auction = new MaskBidAuction(demoParams(32));
        address[4] memory people = [seller, alice, bob, carol];
        for (uint256 i = 0; i < people.length; i++) {
            register(people[i]);
            token.faucet(people[i]);
            vm.prank(people[i]);
            token.approve(address(auction), type(uint256).max);
        }
    }

    function demoParams(uint256 maxBids_) internal view returns (MaskBidAuction.Params memory p) {
        p.admin = admin;
        p.paymentToken = address(token);
        p.assetContract = address(asset);
        p.participantRegistry = address(registry);
        p.callbackSender = adapter;
        p.nearAdapterAccount = "local-mock-adapter";
        p.solverCodeHash = SOLVER_HASH;
        p.profile = "demo";
        p.maxBids = maxBids_;
        p.minDurationSeconds = 180;
        p.maxDurationSeconds = 86_400;
        p.claimWindowSeconds = 300;
        p.settlementGraceSeconds = 1_800;
        p.attemptTimeoutSeconds = 240;
        p.maxAttempts = 3;
    }

    function register(address who) internal {
        vm.prank(registrar);
        registry.registerParticipant(
            who, keccak256(abi.encode("uniq", who)), uint64(vm.getBlockTimestamp() + 30 days), 2, keccak256("proof")
        );
    }

    function mintVerifiedAsset(address issuer) internal returns (uint256 tokenId) {
        vm.prank(issuer);
        tokenId = asset.registerAsset("https://example.invalid/meta.json", keccak256("meta"));
        vm.prank(verifier);
        asset.verifyAndMint(tokenId, keccak256("review"));
    }

    function prepareKey(address owner) internal returns (bytes32 keyId) {
        bytes32 salt = keccak256(abi.encode(owner, auction.keyRequestNonce(owner)));
        vm.prank(owner);
        bytes32 reqId = auction.prepareAuctionKey(salt);
        bytes memory spki = abi.encodePacked("spki-", owner, reqId);
        keyId = sha256(spki);
        MaskBidAuction.KeyResult memory r = MaskBidAuction.KeyResult({
            keyRequestId: reqId,
            owner: owner,
            keyId: keyId,
            publicKeySpki: spki,
            sealedBlobHash: keccak256("sealed"),
            solverCodeHash: SOLVER_HASH,
            configHash: auction.configHash()
        });
        vm.prank(adapter);
        auction.onKeyPrepared(r);
    }

    /// @dev Full happy setup: verified asset, ready key, escrowed auction open now for 600 s.
    function createDemoAuction() internal returns (uint256 auctionId, uint256 tokenId) {
        tokenId = mintVerifiedAsset(seller);
        bytes32 keyId = prepareKey(seller);
        vm.startPrank(seller);
        asset.setApprovalForAll(address(auction), true);
        auctionId = auction.createAuction(
            tokenId, RESERVE, DEPOSIT, uint64(vm.getBlockTimestamp()), uint64(vm.getBlockTimestamp() + 600), keyId
        );
        vm.stopPrank();
    }

    function envelope(bytes32 seed) internal pure returns (bytes memory e) {
        e = new bytes(490);
        e[0] = 0x01;
        e[1] = 0x01;
        e[272] = 0xd9;
        for (uint256 i = 3; i < 35; i++) {
            e[i] = seed[i - 3];
        }
    }

    function bid(uint256 auctionId, address who) internal {
        vm.prank(who);
        auction.placeBid(auctionId, envelope(keccak256(abi.encode(auctionId, who))));
    }

    function closeAndRequest(uint256 auctionId) internal returns (bytes32 requestId) {
        MaskBidAuction.Auction memory a = auction.getAuction(auctionId);
        vm.warp(a.endTime);
        requestId = auction.requestSettlement(auctionId);
    }

    function result(uint256 auctionId, address winner, uint256 amount)
        internal
        view
        virtual
        returns (MaskBidAuction.SettlementResult memory r)
    {
        MaskBidAuction.Auction memory a = auction.getAuction(auctionId);
        r.protocolVersion = 1;
        r.chainId = block.chainid;
        r.auctionContract = address(auction);
        r.auctionId = auctionId;
        r.requestId = a.activeRequestId;
        r.attempt = a.activeAttempt;
        r.bidDigest = a.bidDigest;
        r.bidCount = a.bidCount;
        r.keyId = a.keyId;
        r.solverCodeHash = SOLVER_HASH;
        r.configHash = auction.configHash();
        r.outcome = winner == address(0) ? MaskBidAuction.Outcome.NoSale : MaskBidAuction.Outcome.Winner;
        r.winner = winner;
        r.winningAmountUnits = amount;
        r.validBidCount = a.bidCount;
        r.invalidBidCount = 0;
        r.executionIdHash = keccak256("exec");
        r.outputHash = keccak256("out");
    }

    function deliver(MaskBidAuction.SettlementResult memory r) internal {
        vm.prank(adapter);
        auction.onSettlementResult(r);
    }

    function assertSolvent() internal view {
        assertGe(
            token.balanceOf(address(auction)),
            auction.totalLockedDeposits() + auction.totalSellerCredits(),
            "escrow covers liabilities"
        );
    }

    function state(uint256 id) internal view returns (MaskBidAuction.AuctionState) {
        return auction.getAuction(id).state;
    }
}
