// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Proof-of-personhood registry (spec 05 §2). Registrar writes; contracts read eligibility at entry only.
contract ParticipantRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    uint8 public constant ASSURANCE_REAL_PROVIDER = 1;
    uint8 public constant ASSURANCE_SIMULATOR = 2;
    uint64 public constant MAX_VALIDITY = 30 days;

    struct Participant {
        bytes32 uniquenessId;
        uint64 verifiedUntil;
        uint8 assurance;
        bool revoked;
    }

    /// @dev Deployment policy: real deployments refuse simulator assurance.
    bool public immutable allowSimulator;
    mapping(address => Participant) public participants;
    mapping(bytes32 => address) public walletForUniqueness;

    event ParticipantRegistered(
        address indexed wallet, bytes32 indexed uniquenessId, uint8 assurance, uint64 verifiedUntil, bytes32 proofDigest
    );
    event ParticipantRevoked(address indexed wallet, bytes32 reasonHash);

    error InvalidParticipant();
    error InvalidAssurance();
    error InvalidValidity();
    error UniquenessBound();

    constructor(address admin, address registrar, bool allowSimulator_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, registrar);
        allowSimulator = allowSimulator_;
    }

    function registerParticipant(
        address wallet,
        bytes32 uniquenessId,
        uint64 verifiedUntil,
        uint8 assurance,
        bytes32 proofDigest
    ) external onlyRole(REGISTRAR_ROLE) {
        if (wallet == address(0) || uniquenessId == bytes32(0)) revert InvalidParticipant();
        if (assurance != ASSURANCE_REAL_PROVIDER && assurance != ASSURANCE_SIMULATOR) revert InvalidAssurance();
        if (assurance == ASSURANCE_SIMULATOR && !allowSimulator) revert InvalidAssurance();
        if (verifiedUntil <= block.timestamp || verifiedUntil > block.timestamp + MAX_VALIDITY) revert InvalidValidity();

        Participant storage p = participants[wallet];
        // MVP: no wallet rotation and no ID reassignment; renew only the same wallet/ID pair.
        if (p.uniquenessId != bytes32(0) && p.uniquenessId != uniquenessId) revert UniquenessBound();
        address bound = walletForUniqueness[uniquenessId];
        if (bound != address(0) && bound != wallet) revert UniquenessBound();

        walletForUniqueness[uniquenessId] = wallet;
        p.uniquenessId = uniquenessId;
        p.verifiedUntil = verifiedUntil;
        p.assurance = assurance;
        p.revoked = false;
        emit ParticipantRegistered(wallet, uniquenessId, assurance, verifiedUntil, proofDigest);
    }

    function revokeParticipant(address wallet, bytes32 reasonHash) external onlyRole(REGISTRAR_ROLE) {
        participants[wallet].revoked = true;
        emit ParticipantRevoked(wallet, reasonHash);
    }

    function isEligible(address wallet) external view returns (bool) {
        Participant storage p = participants[wallet];
        return p.uniquenessId != bytes32(0) && !p.revoked && p.verifiedUntil > block.timestamp;
    }

    function uniquenessOf(address wallet) external view returns (bytes32) {
        return participants[wallet].uniquenessId;
    }
}
