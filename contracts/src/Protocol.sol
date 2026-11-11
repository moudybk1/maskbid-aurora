// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice MaskBid protocol v1 hashes (spec 15_PROTOCOL). abi.encode, never encodePacked.
library Protocol {
    uint256 internal constant VERSION = 1;
    uint256 internal constant ENVELOPE_BYTES = 490;

    bytes32 internal constant AAD_TYPE = keccak256("MASKBID_AAD_V1");
    bytes32 internal constant BID_TYPE = keccak256("MASKBID_BID_V1");
    bytes32 internal constant SET_TYPE = keccak256("MASKBID_SET_V1");
    bytes32 internal constant REQUEST_TYPE = keccak256("MASKBID_REQUEST_V1");
    bytes32 internal constant CONFIG_TYPE = keccak256("MASKBID_CONFIG_V1");
    bytes32 internal constant KEY_REQUEST_TYPE = keccak256("MASKBID_KEY_REQUEST_V1");

    function bidHash(
        uint256 chainId,
        address auctionContract,
        uint256 auctionId,
        address bidder,
        bytes32 keyId,
        bytes calldata envelope
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(BID_TYPE, chainId, auctionContract, auctionId, bidder, keyId, keccak256(envelope))
        );
    }

    function initialDigest(uint256 chainId, address auctionContract, uint256 auctionId, bytes32 keyId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(SET_TYPE, chainId, auctionContract, auctionId, keyId));
    }

    function nextDigest(bytes32 previous, uint256 bidIndex, address bidder, bytes32 commitment)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(previous, bidIndex, bidder, commitment));
    }

    function requestId(
        uint256 chainId,
        address auctionContract,
        uint256 auctionId,
        bytes32 bidDigest,
        uint256 bidCount,
        uint32 attempt,
        bytes32 configHash
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(REQUEST_TYPE, chainId, auctionContract, auctionId, bidDigest, bidCount, attempt, configHash)
        );
    }

    function keyRequestId(
        uint256 chainId,
        address auctionContract,
        address owner,
        uint256 nonce,
        bytes32 clientSalt,
        bytes32 configHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(KEY_REQUEST_TYPE, chainId, auctionContract, owner, nonce, clientSalt, configHash));
    }

    /// @dev EVM sender the Aurora engine assigns to a NEAR account calling its `call` method: last 20 bytes of
    ///      keccak256(accountId). The auction pins `callbackSender = implicitAuroraAddress(nearAdapterAccount)`.
    function implicitAuroraAddress(string memory accountId) internal pure returns (address) {
        return address(uint160(uint256(keccak256(bytes(accountId)))));
    }

    /// @dev Envelope header: version 0x01, wrappedKeyLength 256, ciphertextAndTagLength 217. Crypto is checked by the solver.
    function envelopeHeaderValid(bytes calldata envelope) internal pure returns (bool) {
        return envelope.length == ENVELOPE_BYTES && envelope[0] == 0x01 && envelope[1] == 0x01 && envelope[2] == 0x00
            && envelope[271] == 0x00 && envelope[272] == 0xd9;
    }
}
