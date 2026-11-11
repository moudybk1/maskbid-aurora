// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MaskBidAsset} from "./MaskBidAsset.sol";
import {ParticipantRegistry} from "./ParticipantRegistry.sol";
import {Protocol} from "./Protocol.sol";

/// @notice Sealed-bid first-price auction with fixed deposit, pinned per-auction key, ordered bid digest and
/// authenticated settlement callback (spec 05_SMART_CONTRACTS). Money and the asset never leave Aurora.
contract MaskBidAuction is AccessControl, ReentrancyGuard, IERC1155Receiver {
    using SafeERC20 for IERC20;

    bytes32 public constant ENTRY_PAUSER_ROLE = keccak256("ENTRY_PAUSER_ROLE");

    enum AuctionState {
        Created,
        Active,
        Ended,
        PendingClaim,
        Finalized,
        Cancelled
    }
    enum CancelReason {
        None,
        SellerCancelled,
        NoValidBid,
        WinnerDefault,
        SolverTimeout
    }
    enum Outcome {
        Winner,
        NoSale
    }
    enum DepositStatus {
        Locked,
        Refunded,
        Consumed,
        Forfeited
    }
    enum KeyStatus {
        None,
        Requested,
        Ready,
        Consumed
    }

    struct Params {
        address admin;
        address paymentToken;
        address assetContract;
        address participantRegistry;
        address callbackSender;
        string nearAdapterAccount;
        bytes32 solverCodeHash;
        string profile;
        uint256 maxBids;
        uint256 minDurationSeconds;
        uint256 maxDurationSeconds;
        uint256 claimWindowSeconds;
        uint256 settlementGraceSeconds;
        uint256 attemptTimeoutSeconds;
        uint256 maxAttempts;
        /// Aurora XCC precompile (0x516C...b372 on Aurora); zero disables dispatch for the local mock adapter.
        address xccPrecompile;
        /// NEAR gas attached to each adapter call (yoctogas); 200 Tgas covers INIT_KEY dispatch + OutLayer callback.
        uint64 xccGas;
    }

    struct Config {
        uint256 chainId;
        address auctionContract;
        address paymentToken;
        address assetContract;
        address participantRegistry;
        address callbackSender;
        string nearAdapterAccount;
        bytes32 solverCodeHash;
        bytes32 configHash;
        string profile;
        uint256 protocolVersion;
        uint256 maxBids;
        uint256 minDurationSeconds;
        uint256 maxDurationSeconds;
        uint256 claimWindowSeconds;
        uint256 settlementGraceSeconds;
        uint256 attemptTimeoutSeconds;
        uint256 maxAttempts;
        uint256 envelopeBytes;
        address xccPrecompile;
        uint64 xccGas;
    }

    struct Auction {
        uint256 tokenId;
        address seller;
        uint256 reserveUnits;
        uint256 depositUnits;
        uint64 startTime;
        uint64 endTime;
        AuctionState state;
        bytes32 keyId;
        bytes32 solverCodeHash;
        bytes32 configHash;
        uint32 bidCount;
        bytes32 bidDigest;
        uint64 settlementDeadline;
        bytes32 activeRequestId;
        uint32 activeAttempt;
        uint64 attemptStartedAt;
        address winner;
        uint256 winningAmountUnits;
        uint64 claimDeadline;
        CancelReason cancelReason;
        bool returnedAssetClaimed;
    }

    struct Bid {
        address bidder;
        bytes32 identityId;
        bytes32 commitment;
        DepositStatus depositStatus;
    }

    struct KeyRecord {
        address owner;
        bytes32 keyRequestId;
        bytes32 keyId;
        bytes publicKeySpki;
        bytes32 sealedBlobHash;
        KeyStatus status;
    }

    struct KeyResult {
        bytes32 keyRequestId;
        address owner;
        bytes32 keyId;
        bytes publicKeySpki;
        bytes32 sealedBlobHash;
        bytes32 solverCodeHash;
        bytes32 configHash;
    }

    struct SettlementResult {
        uint256 protocolVersion;
        uint256 chainId;
        address auctionContract;
        uint256 auctionId;
        bytes32 requestId;
        uint32 attempt;
        bytes32 bidDigest;
        uint32 bidCount;
        bytes32 keyId;
        bytes32 solverCodeHash;
        bytes32 configHash;
        Outcome outcome;
        address winner;
        uint256 winningAmountUnits;
        uint32 validBidCount;
        uint32 invalidBidCount;
        bytes32 executionIdHash;
        bytes32 outputHash;
    }

    IERC20 public immutable token;
    MaskBidAsset public immutable asset;
    ParticipantRegistry public immutable registry;
    /// @dev Exact sender allowed to deliver key and settlement results (XCC callback identity or local adapter).
    address public immutable callbackSender;
    bytes32 public immutable solverCodeHash;
    bytes32 public immutable configHash;
    uint256 public immutable maxBids;
    uint256 public immutable minDurationSeconds;
    uint256 public immutable maxDurationSeconds;
    uint256 public immutable claimWindowSeconds;
    uint256 public immutable settlementGraceSeconds;
    uint256 public immutable attemptTimeoutSeconds;
    uint256 public immutable maxAttempts;
    address public immutable xccPrecompile;
    uint64 public immutable xccGas;
    string public nearAdapterAccount;
    string public profile;

    bool public entryPaused;
    uint256 public auctionCount;
    uint256 public totalLockedDeposits;
    uint256 public totalSellerCredits;

    mapping(uint256 => Auction) private _auctions;
    mapping(uint256 => mapping(uint256 => Bid)) private _bids;
    mapping(uint256 => mapping(address => uint256)) private _bidIndexPlusOne;
    mapping(uint256 => mapping(bytes32 => bool)) private _usedIdentity;
    mapping(uint256 => uint256) private _auctionOfTokenPlusOne;
    mapping(bytes32 => KeyRecord) private _keys; // keyRequestId => record
    mapping(bytes32 => bytes32) private _keyRequestOfKeyId;
    mapping(address => uint256) public keyRequestNonce;
    mapping(bytes32 => bool) public consumedRequests;
    mapping(address => uint256) private _sellerCredits;
    uint256 private _expectedEscrowTokenId;

    event KeyRequested(bytes32 indexed keyRequestId, address indexed owner, bytes32 configHash);
    event KeyPrepared(
        bytes32 indexed keyRequestId,
        bytes32 indexed keyId,
        address indexed owner,
        bytes publicKeySpki,
        bytes32 sealedBlobHash,
        bytes32 solverCodeHash
    );
    event AuctionCreated(
        uint256 indexed auctionId,
        uint256 indexed tokenId,
        address indexed seller,
        uint256 reserveUnits,
        uint256 depositUnits,
        uint64 startTime,
        uint64 endTime,
        bytes32 keyId,
        bytes32 configHash
    );
    event AuctionActivated(uint256 indexed auctionId, uint64 timestamp);
    event AuctionEnded(uint256 indexed auctionId, uint64 timestamp);
    event BidPlaced(
        uint256 indexed auctionId,
        address indexed bidder,
        uint32 bidIndex,
        bytes32 identityId,
        bytes32 commitment,
        bytes envelope,
        bytes32 newDigest
    );
    event SettlementRequested(
        uint256 indexed auctionId, bytes32 indexed requestId, uint32 attempt, bytes32 bidDigest, uint32 bidCount, uint64 deadline
    );
    event SettlementAccepted(
        uint256 indexed auctionId,
        bytes32 indexed requestId,
        Outcome outcome,
        address winner,
        uint256 winningAmountUnits,
        bytes32 executionIdHash,
        bytes32 outputHash
    );
    event WinClaimed(uint256 indexed auctionId, address indexed winner, address recipient, uint256 totalPaid);
    event DepositRefunded(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event AuctionCancelled(uint256 indexed auctionId, CancelReason reason);
    event WinnerDefaulted(uint256 indexed auctionId, address indexed winner, address indexed seller, uint256 penalty);
    event ReturnedAssetClaimed(uint256 indexed auctionId, address indexed seller, address recipient);
    event SellerCreditWithdrawn(address indexed seller, address recipient, uint256 amount);
    event EntryPauseSet(bool paused);

    error WrongState();
    error AuctionNotStarted();
    error AuctionClosed();
    error InvalidDuration();
    error InvalidDeposit();
    error NotEligible();
    error DuplicateIdentity();
    error DuplicateBid();
    error SellerCannotBid();
    error BidCapReached();
    error InvalidEnvelopeLength();
    error KeyNotReady();
    error KeyAlreadyConsumed();
    error UntrustedCallback();
    error StaleRequest();
    error DigestMismatch();
    error InvalidWinner();
    error BelowReserve();
    error DeadlinePassed();
    error NotWinner();
    error AlreadyRefunded();
    error NothingToWithdraw();
    error InvalidRecipient();
    error EntryPaused();
    error NotSeller();
    error AssetNotVerified();
    error AssetBusy();
    error InvalidKeyResult();
    error AttemptNotTimedOut();
    error MaxAttemptsReached();
    error UnexpectedToken();
    error NotRefundable();
    error AlreadyClaimed();
    error XccDispatchFailed(bytes reason);

    constructor(Params memory p) {
        _grantRole(DEFAULT_ADMIN_ROLE, p.admin);
        _grantRole(ENTRY_PAUSER_ROLE, p.admin);
        token = IERC20(p.paymentToken);
        asset = MaskBidAsset(p.assetContract);
        registry = ParticipantRegistry(p.participantRegistry);
        callbackSender = p.callbackSender;
        solverCodeHash = p.solverCodeHash;
        nearAdapterAccount = p.nearAdapterAccount;
        profile = p.profile;
        maxBids = p.maxBids;
        minDurationSeconds = p.minDurationSeconds;
        maxDurationSeconds = p.maxDurationSeconds;
        claimWindowSeconds = p.claimWindowSeconds;
        settlementGraceSeconds = p.settlementGraceSeconds;
        attemptTimeoutSeconds = p.attemptTimeoutSeconds;
        maxAttempts = p.maxAttempts;
        xccPrecompile = p.xccPrecompile;
        xccGas = p.xccGas;
        configHash = keccak256(
            abi.encode(
                Protocol.CONFIG_TYPE,
                block.chainid,
                address(this),
                p.paymentToken,
                p.assetContract,
                p.participantRegistry,
                p.callbackSender,
                keccak256(bytes(p.nearAdapterAccount)),
                p.solverCodeHash,
                Protocol.VERSION,
                p.maxBids,
                p.minDurationSeconds,
                p.maxDurationSeconds,
                p.claimWindowSeconds,
                p.settlementGraceSeconds,
                p.attemptTimeoutSeconds,
                p.maxAttempts,
                Protocol.ENVELOPE_BYTES
            )
        );
    }

    // ---------------------------------------------------------------- key lifecycle

    function prepareAuctionKey(bytes32 clientSalt) external returns (bytes32 keyRequestId) {
        if (entryPaused) revert EntryPaused();
        if (!registry.isEligible(msg.sender)) revert NotEligible();
        uint256 nonce = keyRequestNonce[msg.sender]++;
        keyRequestId = Protocol.keyRequestId(block.chainid, address(this), msg.sender, nonce, clientSalt, configHash);
        KeyRecord storage k = _keys[keyRequestId];
        k.owner = msg.sender;
        k.keyRequestId = keyRequestId;
        k.status = KeyStatus.Requested;
        emit KeyRequested(keyRequestId, msg.sender, configHash);
        _xcc("request_key", _keyRequestJson(keyRequestId, msg.sender));
    }

    function onKeyPrepared(KeyResult calldata r) external {
        if (msg.sender != callbackSender) revert UntrustedCallback();
        KeyRecord storage k = _keys[r.keyRequestId];
        if (k.status != KeyStatus.Requested) revert WrongState();
        if (
            r.owner != k.owner || r.solverCodeHash != solverCodeHash || r.configHash != configHash
                || r.keyId == bytes32(0) || sha256(r.publicKeySpki) != r.keyId || r.sealedBlobHash == bytes32(0)
                || _keyRequestOfKeyId[r.keyId] != bytes32(0)
        ) revert InvalidKeyResult();
        k.keyId = r.keyId;
        k.publicKeySpki = r.publicKeySpki;
        k.sealedBlobHash = r.sealedBlobHash;
        k.status = KeyStatus.Ready;
        _keyRequestOfKeyId[r.keyId] = r.keyRequestId;
        emit KeyPrepared(r.keyRequestId, r.keyId, k.owner, r.publicKeySpki, r.sealedBlobHash, solverCodeHash);
    }

    // ---------------------------------------------------------------- creation and bidding

    function createAuction(
        uint256 tokenId,
        uint256 reserveUnits,
        uint256 depositUnits,
        uint64 startTime,
        uint64 endTime,
        bytes32 keyId
    ) external nonReentrant returns (uint256 auctionId) {
        if (entryPaused) revert EntryPaused();
        if (!registry.isEligible(msg.sender)) revert NotEligible();
        if (depositUnits == 0 || reserveUnits < depositUnits) revert InvalidDeposit();
        if (startTime == 0) startTime = uint64(block.timestamp); // "start now" without racing the mined block time
        if (startTime < block.timestamp || endTime <= startTime) revert InvalidDuration();
        uint256 duration = endTime - startTime;
        if (duration < minDurationSeconds || duration > maxDurationSeconds) revert InvalidDuration();
        if (_auctionOfTokenPlusOne[tokenId] != 0) revert AssetBusy();

        KeyRecord storage k = _keys[_keyRequestOfKeyId[keyId]];
        if (k.status == KeyStatus.Consumed) revert KeyAlreadyConsumed();
        if (k.status != KeyStatus.Ready || k.owner != msg.sender) revert KeyNotReady();

        MaskBidAsset.AssetData memory data = asset.getAsset(tokenId);
        if (data.status != MaskBidAsset.VerificationStatus.Verified || data.redeemed) revert AssetNotVerified();

        auctionId = ++auctionCount;
        Auction storage a = _auctions[auctionId];
        a.tokenId = tokenId;
        a.seller = msg.sender;
        a.reserveUnits = reserveUnits;
        a.depositUnits = depositUnits;
        a.startTime = startTime;
        a.endTime = endTime;
        a.state = AuctionState.Created;
        a.keyId = keyId;
        a.solverCodeHash = solverCodeHash;
        a.configHash = configHash;
        a.bidDigest = Protocol.initialDigest(block.chainid, address(this), auctionId, keyId);
        a.settlementDeadline = endTime + uint64(settlementGraceSeconds);
        k.status = KeyStatus.Consumed;
        _auctionOfTokenPlusOne[tokenId] = auctionId + 1;

        emit AuctionCreated(
            auctionId, tokenId, msg.sender, reserveUnits, depositUnits, startTime, endTime, keyId, configHash
        );

        _expectedEscrowTokenId = tokenId;
        asset.safeTransferFrom(msg.sender, address(this), tokenId, 1, "");
        _expectedEscrowTokenId = 0;
    }

    function activateAuction(uint256 auctionId) external {
        Auction storage a = _auction(auctionId);
        if (a.state != AuctionState.Created) revert WrongState();
        if (block.timestamp < a.startTime) revert AuctionNotStarted();
        if (block.timestamp >= a.endTime) revert AuctionClosed();
        a.state = AuctionState.Active;
        emit AuctionActivated(auctionId, uint64(block.timestamp));
    }

    function placeBid(uint256 auctionId, bytes calldata envelope) external nonReentrant {
        if (entryPaused) revert EntryPaused();
        Auction storage a = _auction(auctionId);
        if (a.state != AuctionState.Created && a.state != AuctionState.Active) revert WrongState();
        if (block.timestamp < a.startTime) revert AuctionNotStarted();
        if (block.timestamp >= a.endTime) revert AuctionClosed();
        if (msg.sender == a.seller) revert SellerCannotBid();
        if (!registry.isEligible(msg.sender)) revert NotEligible();
        if (_bidIndexPlusOne[auctionId][msg.sender] != 0) revert DuplicateBid();
        bytes32 identityId = registry.uniquenessOf(msg.sender);
        if (_usedIdentity[auctionId][identityId]) revert DuplicateIdentity();
        if (a.bidCount >= maxBids) revert BidCapReached();
        if (!Protocol.envelopeHeaderValid(envelope)) revert InvalidEnvelopeLength();

        bytes32 commitment = Protocol.bidHash(block.chainid, address(this), auctionId, msg.sender, a.keyId, envelope);
        uint32 index = a.bidCount;
        _bids[auctionId][index] = Bid(msg.sender, identityId, commitment, DepositStatus.Locked);
        _bidIndexPlusOne[auctionId][msg.sender] = index + 1;
        _usedIdentity[auctionId][identityId] = true;
        a.bidDigest = Protocol.nextDigest(a.bidDigest, index, msg.sender, commitment);
        a.bidCount = index + 1;
        totalLockedDeposits += a.depositUnits;
        if (a.state == AuctionState.Created) {
            a.state = AuctionState.Active;
            emit AuctionActivated(auctionId, uint64(block.timestamp));
        }
        emit BidPlaced(auctionId, msg.sender, index, identityId, commitment, envelope, a.bidDigest);
        token.safeTransferFrom(msg.sender, address(this), a.depositUnits);
    }

    // ---------------------------------------------------------------- closing and settlement

    function endAuction(uint256 auctionId) public {
        Auction storage a = _auction(auctionId);
        if (a.state == AuctionState.Ended) return;
        if (a.state != AuctionState.Created && a.state != AuctionState.Active) revert WrongState();
        if (block.timestamp < a.endTime) revert AuctionClosed();
        a.state = AuctionState.Ended;
        emit AuctionEnded(auctionId, uint64(block.timestamp));
    }

    function requestSettlement(uint256 auctionId) external returns (bytes32 requestId) {
        endAuction(auctionId);
        Auction storage a = _auctions[auctionId];
        if (a.activeAttempt != 0) revert WrongState();
        return _request(auctionId, a, 1);
    }

    function retrySettlement(uint256 auctionId) external returns (bytes32 requestId) {
        Auction storage a = _auction(auctionId);
        if (a.state != AuctionState.Ended || a.activeAttempt == 0) revert WrongState();
        if (a.activeAttempt >= maxAttempts) revert MaxAttemptsReached();
        if (block.timestamp < a.attemptStartedAt + attemptTimeoutSeconds) revert AttemptNotTimedOut();
        return _request(auctionId, a, a.activeAttempt + 1);
    }

    function _request(uint256 auctionId, Auction storage a, uint32 attempt) private returns (bytes32 requestId) {
        if (block.timestamp >= a.settlementDeadline) revert DeadlinePassed();
        requestId = Protocol.requestId(
            block.chainid, address(this), auctionId, a.bidDigest, a.bidCount, attempt, configHash
        );
        a.activeRequestId = requestId;
        a.activeAttempt = attempt;
        a.attemptStartedAt = uint64(block.timestamp);
        emit SettlementRequested(auctionId, requestId, attempt, a.bidDigest, a.bidCount, a.settlementDeadline);
        _xcc("request_solve", _solveJson(auctionId, a, requestId, attempt));
    }

    function onSettlementResult(SettlementResult calldata r) external nonReentrant {
        if (msg.sender != callbackSender) revert UntrustedCallback();
        Auction storage a = _auction(r.auctionId);
        if (a.state != AuctionState.Ended) revert WrongState();
        if (block.timestamp >= a.settlementDeadline) revert DeadlinePassed();
        if (r.requestId != a.activeRequestId || consumedRequests[r.requestId] || r.attempt != a.activeAttempt) {
            revert StaleRequest();
        }
        if (
            r.protocolVersion != Protocol.VERSION || r.chainId != block.chainid || r.auctionContract != address(this)
                || r.configHash != configHash || r.solverCodeHash != a.solverCodeHash || r.keyId != a.keyId
        ) revert DigestMismatch();
        if (
            r.bidCount != a.bidCount || r.bidDigest != a.bidDigest || r.validBidCount + r.invalidBidCount != r.bidCount
        ) revert DigestMismatch();

        consumedRequests[r.requestId] = true;
        if (r.outcome == Outcome.Winner) {
            if (r.winner == address(0) || _bidIndexPlusOne[r.auctionId][r.winner] == 0) revert InvalidWinner();
            if (r.winningAmountUnits < a.reserveUnits) revert BelowReserve();
            a.state = AuctionState.PendingClaim;
            a.winner = r.winner;
            a.winningAmountUnits = r.winningAmountUnits;
            a.claimDeadline = uint64(block.timestamp + claimWindowSeconds);
        } else {
            if (r.winner != address(0) || r.winningAmountUnits != 0) revert InvalidWinner();
            a.state = AuctionState.Cancelled;
            a.cancelReason = CancelReason.NoValidBid;
        }
        emit SettlementAccepted(
            r.auctionId, r.requestId, r.outcome, r.winner, r.winningAmountUnits, r.executionIdHash, r.outputHash
        );
        if (a.state == AuctionState.Cancelled) emit AuctionCancelled(r.auctionId, CancelReason.NoValidBid);
    }

    // ---------------------------------------------------------------- exits

    function claimWin(uint256 auctionId, address recipient) external nonReentrant {
        Auction storage a = _auction(auctionId);
        if (a.state != AuctionState.PendingClaim) revert WrongState();
        if (msg.sender != a.winner) revert NotWinner();
        if (block.timestamp >= a.claimDeadline) revert DeadlinePassed();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();

        Bid storage b = _bids[auctionId][_bidIndexPlusOne[auctionId][msg.sender] - 1];
        if (b.depositStatus != DepositStatus.Locked) revert WrongState();
        b.depositStatus = DepositStatus.Consumed;
        totalLockedDeposits -= a.depositUnits;
        a.state = AuctionState.Finalized;
        _auctionOfTokenPlusOne[a.tokenId] = 0;
        emit WinClaimed(auctionId, msg.sender, recipient, a.winningAmountUnits);

        uint256 remainder = a.winningAmountUnits - a.depositUnits; // reserve >= deposit guarantees no underflow
        if (remainder > 0) token.safeTransferFrom(msg.sender, address(this), remainder);
        token.safeTransfer(a.seller, a.winningAmountUnits);
        asset.safeTransferFrom(address(this), recipient, a.tokenId, 1, "");
    }

    function claimRefund(uint256 auctionId) external nonReentrant {
        Auction storage a = _auction(auctionId);
        uint256 idx = _bidIndexPlusOne[auctionId][msg.sender];
        if (idx == 0) revert NotRefundable();
        if (a.state == AuctionState.PendingClaim || a.state == AuctionState.Finalized) {
            if (msg.sender == a.winner) revert NotRefundable();
        } else if (a.state != AuctionState.Cancelled) {
            revert WrongState();
        }
        Bid storage b = _bids[auctionId][idx - 1];
        if (b.depositStatus != DepositStatus.Locked) revert AlreadyRefunded();
        b.depositStatus = DepositStatus.Refunded;
        totalLockedDeposits -= a.depositUnits;
        emit DepositRefunded(auctionId, msg.sender, a.depositUnits);
        token.safeTransfer(msg.sender, a.depositUnits);
    }

    function expireClaim(uint256 auctionId) external {
        Auction storage a = _auction(auctionId);
        if (a.state != AuctionState.PendingClaim) revert WrongState();
        if (block.timestamp < a.claimDeadline) revert DeadlinePassed();
        Bid storage b = _bids[auctionId][_bidIndexPlusOne[auctionId][a.winner] - 1];
        b.depositStatus = DepositStatus.Forfeited;
        totalLockedDeposits -= a.depositUnits;
        _sellerCredits[a.seller] += a.depositUnits;
        totalSellerCredits += a.depositUnits;
        a.state = AuctionState.Cancelled;
        a.cancelReason = CancelReason.WinnerDefault;
        emit WinnerDefaulted(auctionId, a.winner, a.seller, a.depositUnits);
        emit AuctionCancelled(auctionId, CancelReason.WinnerDefault);
    }

    function cancelAuction(uint256 auctionId) external {
        Auction storage a = _auction(auctionId);
        if (msg.sender != a.seller) revert NotSeller();
        if (a.state > AuctionState.Ended) revert WrongState();
        if (a.bidCount != 0 || a.activeRequestId != bytes32(0)) revert WrongState();
        a.state = AuctionState.Cancelled;
        a.cancelReason = CancelReason.SellerCancelled;
        emit AuctionCancelled(auctionId, CancelReason.SellerCancelled);
    }

    function cancelAfterSolverTimeout(uint256 auctionId) external {
        Auction storage a = _auction(auctionId);
        if (a.state > AuctionState.Ended) revert WrongState();
        if (block.timestamp < a.settlementDeadline) revert DeadlinePassed();
        a.state = AuctionState.Cancelled;
        a.cancelReason = CancelReason.SolverTimeout;
        emit AuctionCancelled(auctionId, CancelReason.SolverTimeout);
    }

    function claimReturnedAsset(uint256 auctionId, address recipient) external nonReentrant {
        Auction storage a = _auction(auctionId);
        if (a.state != AuctionState.Cancelled) revert WrongState();
        if (msg.sender != a.seller) revert NotSeller();
        if (a.returnedAssetClaimed) revert AlreadyClaimed();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        a.returnedAssetClaimed = true;
        _auctionOfTokenPlusOne[a.tokenId] = 0;
        emit ReturnedAssetClaimed(auctionId, msg.sender, recipient);
        asset.safeTransferFrom(address(this), recipient, a.tokenId, 1, "");
    }

    function withdrawSellerCredit(address recipient) external nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 amount = _sellerCredits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        _sellerCredits[msg.sender] = 0;
        totalSellerCredits -= amount;
        emit SellerCreditWithdrawn(msg.sender, recipient, amount);
        token.safeTransfer(recipient, amount);
    }

    function setEntryPaused(bool paused) external onlyRole(ENTRY_PAUSER_ROLE) {
        entryPaused = paused;
        emit EntryPauseSet(paused);
    }

    // ---------------------------------------------------------------- views

    function getAuction(uint256 auctionId) external view returns (Auction memory) {
        return _auctions[auctionId];
    }

    function getBid(uint256 auctionId, uint256 bidIndex) external view returns (Bid memory) {
        return _bids[auctionId][bidIndex];
    }

    /// @return index plus one; zero when the wallet has not bid.
    function getBidIndex(uint256 auctionId, address bidder) external view returns (uint256) {
        return _bidIndexPlusOne[auctionId][bidder];
    }

    function getKeyRecord(bytes32 keyRequestId) external view returns (KeyRecord memory) {
        return _keys[keyRequestId];
    }

    function getKeyByKeyId(bytes32 keyId) external view returns (KeyRecord memory) {
        return _keys[_keyRequestOfKeyId[keyId]];
    }

    function getSellerCredit(address seller) external view returns (uint256) {
        return _sellerCredits[seller];
    }

    function isRefundable(uint256 auctionId, address wallet) external view returns (bool) {
        Auction storage a = _auctions[auctionId];
        uint256 idx = _bidIndexPlusOne[auctionId][wallet];
        if (idx == 0 || _bids[auctionId][idx - 1].depositStatus != DepositStatus.Locked) return false;
        if (a.state == AuctionState.Cancelled) return true;
        return (a.state == AuctionState.PendingClaim || a.state == AuctionState.Finalized) && wallet != a.winner;
    }

    function getConfig() external view returns (Config memory c) {
        c.chainId = block.chainid;
        c.auctionContract = address(this);
        c.paymentToken = address(token);
        c.assetContract = address(asset);
        c.participantRegistry = address(registry);
        c.callbackSender = callbackSender;
        c.nearAdapterAccount = nearAdapterAccount;
        c.solverCodeHash = solverCodeHash;
        c.configHash = configHash;
        c.profile = profile;
        c.protocolVersion = Protocol.VERSION;
        c.maxBids = maxBids;
        c.minDurationSeconds = minDurationSeconds;
        c.maxDurationSeconds = maxDurationSeconds;
        c.claimWindowSeconds = claimWindowSeconds;
        c.settlementGraceSeconds = settlementGraceSeconds;
        c.attemptTimeoutSeconds = attemptTimeoutSeconds;
        c.maxAttempts = maxAttempts;
        c.envelopeBytes = Protocol.ENVELOPE_BYTES;
        c.xccPrecompile = xccPrecompile;
        c.xccGas = xccGas;
    }

    // ---------------------------------------------------------------- XCC dispatch (Aurora -> NEAR adapter)

    /// @dev Borsh `CrossContractCallArgs::Eager(PromiseArgs::Create(PromiseCreateArgs))` for the XCC precompile: one
    ///      NEAR call to the pinned adapter, which sees `<hex(this)>.aurora` as predecessor. Zero attached NEAR: the router
    ///      sub-account is pre-funded once with the engine's `fund_xcc_sub_account`, so no wNEAR moves here. Compute is paid
    ///      by the adapter's own balance (operator treasury), never by deposits. A synchronous dispatch failure reverts the
    ///      whole request (spec 05 §7); asynchronous failures are retried through `retrySettlement`.
    function _xcc(string memory method, bytes memory args) private {
        if (xccPrecompile == address(0)) return; // local mock adapter consumes the events instead
        bytes memory encoded = abi.encodePacked(
            uint8(0), // Eager
            uint8(0), // Create
            _borsh(bytes(nearAdapterAccount)),
            _borsh(bytes(method)),
            _borsh(args),
            new bytes(16), // attached_balance u128 = 0
            _le(xccGas, 8)
        );
        (bool ok, bytes memory ret) = xccPrecompile.call(encoded);
        if (!ok) revert XccDispatchFailed(ret);
    }

    function _borsh(bytes memory b) private pure returns (bytes memory) {
        return abi.encodePacked(_le(b.length, 4), b);
    }

    function _le(uint256 v, uint256 n) private pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = bytes1(uint8(v >> (8 * i)));
        }
    }

    function _hex(bytes32 v) private pure returns (string memory) {
        return Strings.toHexString(uint256(v), 32);
    }

    /// @dev JSON args of the adapter's `request_key` (near-sdk snake_case parameters).
    function _keyRequestJson(bytes32 keyRequestId, address owner) private view returns (bytes memory) {
        return abi.encodePacked(
            '{"key_request_id":"', _hex(keyRequestId), '","owner":"', Strings.toHexString(owner),
            '","config_hash":"', _hex(configHash), '","solver_code_hash":"', _hex(solverCodeHash), '"}'
        );
    }

    /// @dev JSON args of the adapter's `request_solve`: the trusted request snapshot (spec 15 §8).
    function _solveJson(uint256 auctionId, Auction storage a, bytes32 requestId, uint32 attempt)
        private
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            abi.encodePacked(
                '{"request_id":"', _hex(requestId), '","auction_id":"', Strings.toString(auctionId),
                '","attempt":', Strings.toString(attempt), ',"bid_digest":"', _hex(a.bidDigest),
                '","bid_count":', Strings.toString(a.bidCount)
            ),
            abi.encodePacked(
                ',"key_id":"', _hex(a.keyId), '","key_request_id":"', _hex(_keyRequestOfKeyId[a.keyId]),
                '","reserve_units":"', Strings.toString(a.reserveUnits), '","end_time":', Strings.toString(a.endTime),
                ',"settlement_deadline":', Strings.toString(a.settlementDeadline)
            ),
            abi.encodePacked(',"config_hash":"', _hex(configHash), '","solver_code_hash":"', _hex(solverCodeHash), '"}')
        );
    }

    // ---------------------------------------------------------------- ERC1155 receiver (escrow only)

    function onERC1155Received(address, address, uint256 id, uint256 value, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        if (msg.sender != address(asset) || id != _expectedEscrowTokenId || value != 1) revert UnexpectedToken();
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert UnexpectedToken();
    }

    function supportsInterface(bytes4 interfaceId) public view override(AccessControl, IERC165) returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || super.supportsInterface(interfaceId);
    }

    function _auction(uint256 auctionId) private view returns (Auction storage a) {
        a = _auctions[auctionId];
        if (a.seller == address(0)) revert WrongState();
    }
}
