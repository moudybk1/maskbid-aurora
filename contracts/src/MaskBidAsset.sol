// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ParticipantRegistry} from "./ParticipantRegistry.sol";

/// @notice One verified unit per tokenId (spec 05 §3). Metadata is immutable from registration.
contract MaskBidAsset is ERC1155, AccessControl {
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant ENTRY_PAUSER_ROLE = keccak256("ENTRY_PAUSER_ROLE");
    uint256 public constant MAX_URI_LENGTH = 512;

    enum VerificationStatus {
        Pending,
        Verified,
        Rejected
    }

    struct AssetData {
        address issuer;
        string metadataURI;
        bytes32 metadataHash;
        VerificationStatus status;
        address reviewer;
        bytes32 reviewDigest;
        bool minted;
        bool redeemed;
    }

    ParticipantRegistry public immutable registry;
    uint256 public nextTokenId = 1;
    bool public entryPaused;
    mapping(uint256 => AssetData) private _assets;

    event AssetRegistered(uint256 indexed tokenId, address indexed issuer, string metadataURI, bytes32 metadataHash);
    event AssetVerified(uint256 indexed tokenId, address indexed reviewer, bytes32 reviewDigest);
    event AssetRejected(uint256 indexed tokenId, address indexed reviewer, bytes32 reasonHash);
    event AssetRedeemed(uint256 indexed tokenId, address indexed owner);
    event EntryPauseSet(bool paused);

    error NotEligible();
    error EntryPaused();
    error InvalidMetadata();
    error UnknownAsset();
    error WrongState();
    error ReviewerIsIssuer();
    error InvalidDigest();
    error NotHolder();
    error AlreadyRedeemed();

    constructor(address admin, address verifier, ParticipantRegistry registry_) ERC1155("") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VERIFIER_ROLE, verifier);
        _grantRole(ENTRY_PAUSER_ROLE, admin);
        registry = registry_;
    }

    function registerAsset(string calldata metadataURI, bytes32 metadataHash) external returns (uint256 tokenId) {
        if (entryPaused) revert EntryPaused();
        if (!registry.isEligible(msg.sender)) revert NotEligible();
        uint256 len = bytes(metadataURI).length;
        if (len == 0 || len > MAX_URI_LENGTH || metadataHash == bytes32(0)) revert InvalidMetadata();
        tokenId = nextTokenId++;
        AssetData storage a = _assets[tokenId];
        a.issuer = msg.sender;
        a.metadataURI = metadataURI;
        a.metadataHash = metadataHash;
        emit AssetRegistered(tokenId, msg.sender, metadataURI, metadataHash);
    }

    /// @dev Verifier never equals issuer; mint exactly one unit in the same transaction.
    function verifyAndMint(uint256 tokenId, bytes32 reviewDigest) external onlyRole(VERIFIER_ROLE) {
        AssetData storage a = _pending(tokenId);
        if (reviewDigest == bytes32(0)) revert InvalidDigest();
        a.status = VerificationStatus.Verified;
        a.reviewer = msg.sender;
        a.reviewDigest = reviewDigest;
        a.minted = true;
        emit AssetVerified(tokenId, msg.sender, reviewDigest);
        _mint(a.issuer, tokenId, 1, "");
    }

    function rejectAsset(uint256 tokenId, bytes32 reasonHash) external onlyRole(VERIFIER_ROLE) {
        AssetData storage a = _pending(tokenId);
        a.status = VerificationStatus.Rejected;
        a.reviewer = msg.sender;
        emit AssetRejected(tokenId, msg.sender, reasonHash);
    }

    /// @notice Burn the unit you hold. Proves token redemption only, not physical delivery.
    function redeem(uint256 tokenId) external {
        AssetData storage a = _assets[tokenId];
        if (a.issuer == address(0)) revert UnknownAsset();
        if (a.redeemed) revert AlreadyRedeemed();
        if (balanceOf(msg.sender, tokenId) != 1) revert NotHolder();
        a.redeemed = true;
        _burn(msg.sender, tokenId, 1);
        emit AssetRedeemed(tokenId, msg.sender);
    }

    function setEntryPaused(bool paused) external onlyRole(ENTRY_PAUSER_ROLE) {
        entryPaused = paused;
        emit EntryPauseSet(paused);
    }

    function getAsset(uint256 tokenId) external view returns (AssetData memory) {
        return _assets[tokenId];
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        return _assets[tokenId].metadataURI;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _pending(uint256 tokenId) private view returns (AssetData storage a) {
        a = _assets[tokenId];
        if (a.issuer == address(0)) revert UnknownAsset();
        if (a.status != VerificationStatus.Pending) revert WrongState();
        if (a.issuer == msg.sender) revert ReviewerIsIssuer();
    }
}
