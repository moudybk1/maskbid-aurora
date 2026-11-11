// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {BaseTest} from "./Base.t.sol";
import {MaskBidAuction} from "../src/MaskBidAuction.sol";
import {Protocol} from "../src/Protocol.sol";

/// @dev Stands in for the XCC precompile: records the borsh promise it was handed, or fails on demand.
contract XccRecorder {
    bytes public last;
    uint256 public calls;
    bool public down;

    function setDown(bool v) external {
        down = v;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        if (down) revert("xcc down");
        last = data;
        calls++;
        return "";
    }
}

/// G-01 (local half): the auction dispatches exactly one borsh-encoded Eager/Create promise to the pinned adapter
/// with the trusted request snapshot as JSON, pins the derived callback sender, and cancels on dispatch failure.
contract XccTest is BaseTest {
    XccRecorder rec;
    MaskBidAuction x;
    string constant ADAPTER = "maskbid-adapter.testnet";
    uint64 constant GAS = 200_000_000_000_000;

    function setUp() public override {
        super.setUp();
        rec = new XccRecorder();
        MaskBidAuction.Params memory p = demoParams(32);
        p.nearAdapterAccount = ADAPTER;
        p.callbackSender = Protocol.implicitAuroraAddress(ADAPTER);
        p.xccPrecompile = address(rec);
        p.xccGas = GAS;
        x = new MaskBidAuction(p);
        vm.prank(seller);
        asset.setApprovalForAll(address(x), true);
        vm.prank(alice);
        token.approve(address(x), type(uint256).max);
    }

    function test_DerivedCallbackSender() public pure {
        // cast keccak "maskbid-adapter.testnet" -> last 20 bytes
        assertEq(Protocol.implicitAuroraAddress(ADAPTER), 0x780dFA1E400790fffAeC39CF89c4c8182843570C);
    }

    function _promise(string memory method, bytes memory args) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(0), uint8(0), _le(bytes(ADAPTER).length, 4), ADAPTER, _le(bytes(method).length, 4), method,
            _le(args.length, 4), args, new bytes(16), _le(GAS, 8)
        );
    }

    function _le(uint256 v, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = bytes1(uint8(v >> (8 * i)));
        }
    }

    function _h(bytes32 v) internal pure returns (string memory) {
        return Strings.toHexString(uint256(v), 32);
    }

    function test_PrepareKeyDispatchesRequestKey() public {
        vm.prank(seller);
        bytes32 id = x.prepareAuctionKey(bytes32(uint256(1)));
        assertEq(rec.calls(), 1);
        bytes memory args = abi.encodePacked(
            '{"key_request_id":"', _h(id), '","owner":"', Strings.toHexString(seller), '","config_hash":"', _h(x.configHash()),
            '","solver_code_hash":"', _h(SOLVER_HASH), '"}'
        );
        assertEq(rec.last(), _promise("request_key", args));
    }

    function test_RequestSettlementDispatchesRequestSolve() public {
        vm.prank(seller);
        bytes32 reqId = x.prepareAuctionKey(bytes32(0));
        bytes memory spki = "spki";
        bytes32 keyId = sha256(spki);
        bytes32 cfg = x.configHash(); // read before the prank: a view call would consume it
        vm.prank(Protocol.implicitAuroraAddress(ADAPTER));
        x.onKeyPrepared(MaskBidAuction.KeyResult(reqId, seller, keyId, spki, keccak256("s"), SOLVER_HASH, cfg));
        uint256 tokenId = mintVerifiedAsset(seller);
        uint64 t = uint64(vm.getBlockTimestamp());
        vm.prank(seller);
        uint256 id = x.createAuction(tokenId, RESERVE, DEPOSIT, t, t + 600, keyId);
        vm.prank(alice);
        x.placeBid(id, envelope(keccak256("a")));
        vm.warp(t + 600);
        bytes32 rid = x.requestSettlement(id);
        assertEq(rec.calls(), 2);
        MaskBidAuction.Auction memory a = x.getAuction(id);
        bytes memory args = abi.encodePacked(
            abi.encodePacked(
                '{"request_id":"', _h(rid), '","auction_id":"', Strings.toString(id), '","attempt":1,"bid_digest":"', _h(a.bidDigest),
                '","bid_count":1'
            ),
            abi.encodePacked(
                ',"key_id":"', _h(keyId), '","key_request_id":"', _h(reqId), '","reserve_units":"', Strings.toString(RESERVE),
                '","end_time":', Strings.toString(a.endTime), ',"settlement_deadline":', Strings.toString(a.settlementDeadline)
            ),
            abi.encodePacked(',"config_hash":"', _h(x.configHash()), '","solver_code_hash":"', _h(SOLVER_HASH), '"}')
        );
        assertEq(rec.last(), _promise("request_solve", args));

        // only the derived sender may deliver, and a stale attempt is rejected after a retry
        MaskBidAuction.SettlementResult memory r = result(id, alice, 150e6);
        r.solverCodeHash = SOLVER_HASH;
        r.configHash = x.configHash();
        vm.prank(stranger);
        vm.expectRevert(MaskBidAuction.UntrustedCallback.selector);
        x.onSettlementResult(r);
        vm.warp(t + 600 + 240);
        x.retrySettlement(id);
        assertEq(rec.calls(), 3);
        vm.prank(Protocol.implicitAuroraAddress(ADAPTER));
        vm.expectRevert(MaskBidAuction.StaleRequest.selector);
        x.onSettlementResult(r);
    }

    function test_DispatchFailureRevertsRequest() public {
        rec.setDown(true);
        vm.prank(seller);
        vm.expectRevert();
        x.prepareAuctionKey(bytes32(0));
        assertEq(x.keyRequestNonce(seller), 0, "state rolled back");
    }

    /// `result()` in BaseTest reads from `auction`, not `x`; rebuild the bindings for `x` here.
    function result(uint256 auctionId, address winner, uint256 amount)
        internal
        view
        override
        returns (MaskBidAuction.SettlementResult memory r)
    {
        MaskBidAuction.Auction memory a = x.getAuction(auctionId);
        r.protocolVersion = 1;
        r.chainId = block.chainid;
        r.auctionContract = address(x);
        r.auctionId = auctionId;
        r.requestId = a.activeRequestId;
        r.attempt = a.activeAttempt;
        r.bidDigest = a.bidDigest;
        r.bidCount = a.bidCount;
        r.keyId = a.keyId;
        r.outcome = winner == address(0) ? MaskBidAuction.Outcome.NoSale : MaskBidAuction.Outcome.Winner;
        r.winner = winner;
        r.winningAmountUnits = amount;
        r.validBidCount = a.bidCount;
        r.executionIdHash = keccak256("exec");
        r.outputHash = keccak256("out");
    }
}
