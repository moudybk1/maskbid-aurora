// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Protocol} from "../src/Protocol.sol";

contract ProtocolHarness {
    function bidHash(uint256 c, address a, uint256 id, address b, bytes32 k, bytes calldata e)
        external
        pure
        returns (bytes32)
    {
        return Protocol.bidHash(c, a, id, b, k, e);
    }

    function headerValid(bytes calldata e) external pure returns (bool) {
        return Protocol.envelopeHeaderValid(e);
    }
}

/// @notice Solidity side of the cross-language vector check (spec 15 §12).
contract ProtocolTest is Test {
    ProtocolHarness h = new ProtocolHarness();
    string json;

    function setUp() public {
        json = vm.readFile("../packages/protocol/vectors/protocol-vectors.json");
    }

    function test_VectorsRecompute() public view {
        uint256 chainId = vm.parseJsonUint(json, ".request.chainId");
        address auction = vm.parseJsonAddress(json, ".request.auctionContract");
        uint256 auctionId = vm.parseJsonUint(json, ".request.auctionId");
        bytes32 keyId = vm.parseJsonBytes32(json, ".request.keyId");

        bytes32 digest = Protocol.initialDigest(chainId, auction, auctionId, keyId);
        assertEq(digest, vm.parseJsonBytes32(json, ".initialDigest"), "initial digest");

        for (uint256 i = 0; i < 3; i++) {
            string memory p = string.concat(".bids[", vm.toString(i), "]");
            bytes memory envelope = vm.parseJsonBytes(json, string.concat(p, ".envelope"));
            address bidder = vm.parseJsonAddress(json, string.concat(p, ".bidder"));
            assertTrue(h.headerValid(envelope), "header");
            bytes32 commitment = h.bidHash(chainId, auction, auctionId, bidder, keyId, envelope);
            assertEq(commitment, vm.parseJsonBytes32(json, string.concat(p, ".commitment")), "commitment");
            digest = Protocol.nextDigest(digest, i, bidder, commitment);
            assertEq(digest, vm.parseJsonBytes32(json, string.concat(p, ".digestAfter")), "digest");
        }

        bytes32 requestId = Protocol.requestId(
            chainId,
            auction,
            auctionId,
            digest,
            3,
            uint32(vm.parseJsonUint(json, ".request.attempt")),
            vm.parseJsonBytes32(json, ".request.configHash")
        );
        assertEq(requestId, vm.parseJsonBytes32(json, ".request.requestId"), "requestId");
    }

    function test_HeaderRejectsWrongLengthAndVersion() public view {
        bytes memory e = new bytes(490);
        e[0] = 0x01;
        e[1] = 0x01;
        e[272] = 0xd9;
        assertTrue(h.headerValid(e));
        e[0] = 0x02;
        assertFalse(h.headerValid(e));
        assertFalse(h.headerValid(new bytes(489)));
    }
}
