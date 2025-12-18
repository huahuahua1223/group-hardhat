// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @notice Room contract initialization interface
 */
interface IRoom {
    function initialize(
        address owner_,
        address unichatToken,
        address community,
        uint256 inviteFee,
        bool plaintextEnabled,
        uint32 messageMaxBytes
    ) external;
}

/**
 * @notice Red packet contract interface (for inline red packet calls)
 */
interface IUniChatRedPacket {
    function createGroupPacketFor(
        address creator,
        address token,
        uint256 totalAmount,
        uint256 totalShares,
        bool isRandom,
        address groupContract,
        uint256[] calldata shareAmounts,
        uint256 expiryDuration
    ) external returns (uint256 packetId);
}

/**
 * @title Community
 * @notice Large group contract with Merkle Tree-based whitelist access mechanism
 * @dev Only stores Merkle Root + Epoch, members must submit MerkleProof on-chain binding before creating/participating in rooms
 *      Uses EIP-1167 minimal proxy pattern to clone Room instances
 */
contract Community is Ownable, Pausable {
    using MerkleProof for bytes32[];
    using SafeERC20 for IERC20;

    /* ===================== Events ===================== */
    /// @notice Emitted when Merkle Root is updated
    event MerkleRootUpdated(uint256 indexed epoch, bytes32 root, string uri);
    
    /// @notice Emitted when a user joins the large group
    event Joined(address indexed account, uint256 tier, uint256 epoch);
    
    // Large group built-in messages
    event CommunityMessageBroadcasted(
        address indexed community,
        address indexed sender,
        uint8   kind,          // 0: plaintext, 1: ciphertext
        uint256 indexed seq,
        bytes32 contentHash,
        string  cid,
        uint40  ts
    );

    event DefaultRoomParamsUpdated(uint256 defaultInviteFee, bool defaultPlaintextEnabled);
    event RoomCreated(address indexed room, address indexed owner, uint256 inviteFee);

    // Group chat key
    event GroupKeyEpochIncreased(uint64 epoch, bytes32 metadataHash);
    event RsaGroupPublicKeyUpdated(uint64 epoch, string rsaPublicKey);

    // Key distribution
    event KeyDistributed(uint64 indexed distributionEpoch, bytes32 merkleRoot, string ipfsCid, uint40 timestamp);

    // Metadata
    event CommunityMetadataSet(address indexed topicToken, uint8 maxTier, string name, string avatarCid);
    
    /// @notice Emitted when large group ownership is transferred
    event CommunityOwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /* ===================== State Variables ===================== */
    /// @notice Fee token contract address
    IERC20 public UNICHAT;
    
    /// @notice Treasury address that receives room creation fees
    address public treasury;
    
    /// @notice Fee required to create a room
    uint256 public roomCreateFee;
    
    /// @notice Room implementation contract address (for cloning)
    address public roomImplementation;

    /// @notice Merkle Root mapping, epoch => root
    mapping(uint256 => bytes32) public merkleRoots;
    
    /// @notice Current epoch version number
    uint256 public currentEpoch;
    
    /// @notice Last set Merkle metadata URI
    string public lastMerkleURI;

    /// @notice Whether user is a member
    mapping(address => bool) public isMember;
    
    /// @notice User's asset tier
    mapping(address => uint256) public memberTier;
    
    /// @notice Epoch when user last joined
    mapping(address => uint256) public lastJoinedEpoch;

    /// @notice List of all created room addresses
    address[] public rooms;

    /// @notice Total number of large group members
    uint256 public membersCount;

    /// @notice List of all member addresses
    address[] public members;

    /// @notice Whether initialized (prevents re-initialization)
    bool private _initialized;
    
    /// @notice Used nonces to prevent replay attacks (scoped by user)
    mapping(address => mapping(bytes32 => bool)) public usedNonces;
    
    // ========== New: Large group built-in messages ==========
    struct Message {
        address sender;
        uint40  ts;
        uint8   kind;      // 0 plaintext, 1 ciphertext
        string  content;   // Plain/ciphertext (encrypted by frontend)
        string  cid;       // External reference (optional)
    }
    Message[] private _messages;
    uint256 public seq;                   // Large group message sequence number
    bool    public plaintextEnabled;      // Whether plaintext is allowed (default true)
    uint32  public communityMessageMaxBytes;  // Default 2048

    // ========== New: RSA group chat public key ==========
    string public rsaGroupPublicKey;      // Group chat public key used by frontend (PEM/Base64 text)
    uint64 public groupKeyEpoch;          // Rotation version

    // ========== New: Topic token & unique key & metadata ==========
    address public topicToken;            // Topic token bound to this large group
    uint8   public maxTier;               // 1..7
    string  public name_;                 // Group name
    string  public avatarCid;             // Avatar CID

    // ========== New: Key distribution information ==========
    struct KeyDistribution {
        bytes32 merkleRoot;         // Merkle Root of member addresses and encrypted keys
        string ipfsCid;             // IPFS file CID (stores complete encrypted key data)
        uint64 distributionEpoch;   // Distribution version number
        uint40 timestamp;           // Distribution timestamp
    }
    
    /// @notice Key distribution records: distributionEpoch => KeyDistribution
    mapping(uint64 => KeyDistribution) public keyDistributions;
    
    /// @notice Current key distribution version number
    uint64 public currentDistributionEpoch;
    
    /// @notice Default room invite fee (set by large group owner)
    uint256 public defaultInviteFee;
    
    /// @notice Default whether plaintext messages are enabled for rooms (set by large group owner)
    bool public defaultPlaintextEnabled;
    
    /// @notice Maximum message bytes (fixed at 2048)
    uint32 public constant MESSAGE_MAX_BYTES = 2048;

    /// @notice Red packet contract reference (for inline red packet calls)
    IUniChatRedPacket public redPacket;

    /* ===================== Constructor ===================== */
    /**
     * @notice Constructor (only for implementation contract)
     * @dev Satisfies OpenZeppelin v5 requirement: set owner to deployer when deploying implementation contract
     *      Cloned instances will reset owner in initialize()
     */
    constructor() Ownable(msg.sender) {
        // Lock implementation contract to prevent calling initialize on "implementation contract itself"
        _initialized = true;
    }

    /* ===================== Modifiers ===================== */
    /**
     * @notice Only active members can call
     * @dev Checks if caller is a member and epoch version matches
     */
    modifier onlyActiveMember() {
        require(isMember[msg.sender] && lastJoinedEpoch[msg.sender] == currentEpoch, "NotActiveMember");
        _;
    }

    /* ===================== Initialization Function (for cloned instances) ===================== */
    /**
     * @notice Initialize cloned Community instance
     * @dev Can only be called once, sets group owner and related parameters
     */
    function initialize(
        address communityOwner,
        address unichatToken,
        address _treasury,
        uint256 _roomCreateFee,
        address _roomImplementation,

        // New metadata
        address _topicToken,
        uint8   _maxTier,
        string calldata _name,
        string calldata _avatarCid
    ) external {
        require(!_initialized, "Initialized");
        require(communityOwner != address(0) && unichatToken != address(0) && _treasury != address(0), "ZeroAddr");
        require(_topicToken != address(0), "ZeroTopic");
        require(_maxTier >= 1 && _maxTier <= 7, "BadTier");

        // Set cloned instance's owner to specified group owner
        _transferOwnership(communityOwner);

        UNICHAT = IERC20(unichatToken);
        treasury = _treasury;
        roomCreateFee = _roomCreateFee;
        roomImplementation = _roomImplementation;
        
        // Large group message default parameters
        plaintextEnabled = true;
        communityMessageMaxBytes = 2048;

        // Topic token & metadata
        topicToken = _topicToken;
        maxTier    = _maxTier;
        name_      = _name;
        avatarCid  = _avatarCid;

        emit CommunityMetadataSet(_topicToken, _maxTier, _name, _avatarCid);
        
        // Set default room parameters
        defaultInviteFee = 0;  // Default free invitation
        defaultPlaintextEnabled = true;  // Default enable plaintext messages

        _initialized = true;
    }

    /* ===================== Merkle Root Management ===================== */
    /**
     * @notice Set new Merkle Root
     * @dev Only owner can call, each setting automatically increments epoch version number
     *      Used to update whitelist, all members need to rejoin with new proof
     */
    function setMerkleRoot(bytes32 newRoot, string calldata uri) external onlyOwner whenNotPaused {
        require(newRoot != bytes32(0), "ZeroRoot");
        currentEpoch += 1;
        merkleRoots[currentEpoch] = newRoot;
        lastMerkleURI = uri;
        emit MerkleRootUpdated(currentEpoch, newRoot, uri);
    }

    /**
     * @notice Check if user is eligible to join large group (read-only function)
     * @dev Used for frontend display, does not consume gas
     *      Validates epoch, expiration time and Merkle Proof validity
     */
    function eligible(
        address account,
        uint256 _maxTier,
        uint256 epoch,
        uint256 validUntil,
        bytes32 nonce,
        bytes32[] calldata proof
    ) external view returns (bool) {
        if (epoch != currentEpoch) return false;
        if (validUntil != 0 && block.timestamp > validUntil) return false;
        bytes32 leaf = computeLeaf(address(this), epoch, account, _maxTier, validUntil, nonce);
        return proof.verify(merkleRoots[epoch], leaf);
    }

    /**
     * @notice Join large group
     * @dev User submits Merkle Proof to prove they are on whitelist
     *      After verification, records member information and asset tier
     *      Must use current epoch's proof and cannot be expired
     */
    function joinCommunity(
        uint256 _maxTier,
        uint256 epoch,
        uint256 validUntil,
        bytes32 nonce,
        bytes32[] calldata proof
    ) external whenNotPaused {
        require(epoch == currentEpoch, "EpochMismatch");
        if (validUntil != 0) require(block.timestamp <= validUntil, "ProofExpired");

        bytes32 leaf = computeLeaf(address(this), epoch, msg.sender, _maxTier, validUntil, nonce);
        require(proof.verify(merkleRoots[epoch], leaf), "BadProof");
        
        // Prevent nonce replay attacks (scoped by user)
        require(!usedNonces[msg.sender][nonce], "NonceUsed");
        usedNonces[msg.sender][nonce] = true;

        _addMember(msg.sender, _maxTier, epoch);
    }

    /**
     * @notice Owner directly invites member to join large group (no Merkle Proof required)
     * @dev Only owner can call, directly adds member without Merkle tree verification
     * @param account Address of member to add
     * @param _maxTier Member's asset tier (1-7)
     */
    function inviteMember(address account, uint256 _maxTier) external onlyOwner whenNotPaused {
        require(account != address(0), "ZeroAddr");
        require(_maxTier >= 1 && _maxTier <= maxTier, "BadTier");
        
        _addMember(account, _maxTier, currentEpoch);
    }

    /**
     * @notice Internal function: add member
     * @dev Unified member addition logic, including new member counting and state updates
     * @param account Member address
     * @param _maxTier Asset tier
     * @param epoch Epoch when joined
     */
    function _addMember(address account, uint256 _maxTier, uint256 epoch) internal {
        // If new member, add to member list and increment count
        bool isNewMember = !isMember[account];
        if (isNewMember) {
            members.push(account);
            membersCount += 1;
        }

        isMember[account] = true;
        memberTier[account] = _maxTier;
        lastJoinedEpoch[account] = epoch;

        emit Joined(account, _maxTier, epoch);
    }

    /**
     * @notice Calculate Merkle Tree leaf node hash
     * @dev Public function for off-chain generation and on-chain verification of proof
     *      Leaf node contains: group address, epoch, user address, tier, expiration time, nonce
     */
    function computeLeaf(
        address community,
        uint256 epoch,
        address account,
        uint256 _maxTier,
        uint256 validUntil,
        bytes32 nonce
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(community, epoch, account, _maxTier, validUntil, nonce));
    }

    /**
     * @notice Check if user is an active member
     * @dev User must have joined and epoch version matches
     */
    function isActiveMember(address account) external view returns (bool) {
        return isMember[account] && lastJoinedEpoch[account] == currentEpoch;
    }

    /**
     * @notice Get group chat basic metadata
     * @return topicToken_ Topic token address
     * @return maxTier_ Maximum tier
     * @return name Group name
     * @return avatar Avatar CID
     * @return owner_ Group owner address
     * @return epoch Current epoch version
     */
    function getMetadata() external view returns (
        address topicToken_,
        uint8 maxTier_,
        string memory name,
        string memory avatar,
        address owner_,
        uint256 epoch
    ) {
        return (
            topicToken,
            maxTier,
            name_,
            avatarCid,
            owner(),
            currentEpoch
        );
    }

    /* ===================== Large Group Built-in Messages ===================== */
    /**
     * @notice Send message in large group
     * @dev Only active members can call
     *      kind: 0=plaintext, 1=ciphertext
     */
    function sendCommunityMessage(
        uint8   kind,        // 0=plaintext, 1=ciphertext
        string calldata content,
        string calldata cid
    ) external onlyActiveMember whenNotPaused {
        _sendCommunityMessage(msg.sender, kind, content, cid);
    }

    /**
     * @notice Internal function: send large group message
     * @dev Extracts core logic for reuse by sendCommunityMessage and sendRedPacketMessage
     * @param from Message sender address
     * @param kind Message type: 0=plaintext, 1=ciphertext
     * @param content Message content
     * @param cid External reference (optional)
     */
    function _sendCommunityMessage(
        address from,
        uint8   kind,
        string memory content,
        string memory cid
    ) internal {
        if (kind == 0) {
            require(plaintextEnabled, "PlaintextOff");
        }
        require(bytes(content).length <= communityMessageMaxBytes, "TooLarge");

        seq += 1;
        uint40 ts = uint40(block.timestamp);
        bytes32 contentHash = keccak256(bytes(content));

        emit CommunityMessageBroadcasted(address(this), from, kind, seq, contentHash, cid, ts);

        _messages.push(Message({
            sender: from,
            ts: ts,
            kind: kind,
            content: content,
            cid: cid
        }));
    }

    /**
     * @notice Complete in one transaction: create group red packet + write a red packet message
     * @dev Only active members can call, user must approve tokens to red packet contract in advance
     * @param token Red packet token
     * @param totalAmount Total red packet amount
     * @param totalShares Number of shares
     * @param isRandom Whether random red packet
     * @param shareAmounts Array of per-share amounts for random red packet; empty array for non-random
     * @param expiryDuration Expiration duration in seconds
     * @param msgKind Message kind (0=plaintext, 1=ciphertext)
     * @param memo Red packet blessing message, displayed as content in chat history
     */
    function sendRedPacketMessage(
        address token,
        uint256 totalAmount,
        uint256 totalShares,
        bool    isRandom,
        uint256[] calldata shareAmounts,
        uint256 expiryDuration,
        uint8   msgKind,
        string calldata memo
    ) external onlyActiveMember whenNotPaused returns (uint256 packetId) {
        require(address(redPacket) != address(0), "RedPacket not set");

        // 1. Call red packet contract to create group red packet (note: pass creator=msg.sender)
        packetId = redPacket.createGroupPacketFor(
            msg.sender,
            token,
            totalAmount,
            totalShares,
            isRandom,
            address(this),   // Current group contract
            shareAmounts,
            expiryDuration
        );

        // 2. Encode packetId into cid
        string memory cid = string.concat(
            "redpacket:v1:",
            Strings.toString(packetId)
        );

        // 3. Call internal function to write a group message (sender=user)
        _sendCommunityMessage(msg.sender, msgKind, memo, cid);
    }

    /**
     * @notice Get total number of large group messages
     */
    function communityMessageCount() external view returns (uint256) {
        return _messages.length;
    }

    /**
     * @notice Get large group message at specified index
     */
    function getCommunityMessage(uint256 index) external view returns (
        address sender, uint40 ts, uint8 kind, string memory content, string memory cid
    ) {
        Message storage m = _messages[index];
        return (m.sender, m.ts, m.kind, m.content, m.cid);
    }

    /**
     * @notice Get large group messages with pagination
     * @param start Starting index
     * @param count Number to retrieve
     */
    function getCommunityMessages(uint256 start, uint256 count) external view returns (Message[] memory) {
        uint256 total = _messages.length;
        if (start >= total) return new Message[](0);
        uint256 end = start + count;
        if (end > total) end = total;
        uint256 n = end - start;
        Message[] memory out = new Message[](n);
        for (uint256 i = 0; i < n; i++) out[i] = _messages[start + i];
        return out;
    }

    /**
     * @notice Get large group plaintext messages with pagination (only returns messages with kind=0)
     * @param start Starting index (based on all messages array)
     * @param count Maximum number to retrieve
     * @return Plaintext message array
     */
    function getPlaintextMessages(uint256 start, uint256 count) external view returns (Message[] memory) {
        uint256 total = _messages.length;
        if (start >= total) return new Message[](0);

        // First pass: count plaintext messages
        uint256 plaintextCount = 0;
        uint256 scanned = 0;
        for (uint256 i = start; i < total && scanned < count; i++) {
            if (_messages[i].kind == 0) {
                plaintextCount++;
            }
            scanned++;
        }

        // Second pass: fill result array
        Message[] memory out = new Message[](plaintextCount);
        uint256 outIndex = 0;
        scanned = 0;
        for (uint256 i = start; i < total && scanned < count; i++) {
            if (_messages[i].kind == 0) {
                out[outIndex] = _messages[i];
                outIndex++;
            }
            scanned++;
        }

        return out;
    }

    /**
     * @notice Get large group ciphertext messages with pagination (only returns messages with kind=1)
     * @param start Starting index (based on all messages array)
     * @param count Maximum number to retrieve
     * @return Ciphertext message array
     */
    function getEncryptedMessages(uint256 start, uint256 count) external view returns (Message[] memory) {
        uint256 total = _messages.length;
        if (start >= total) return new Message[](0);

        // First pass: count ciphertext messages
        uint256 encryptedCount = 0;
        uint256 scanned = 0;
        for (uint256 i = start; i < total && scanned < count; i++) {
            if (_messages[i].kind == 1) {
                encryptedCount++;
            }
            scanned++;
        }

        // Second pass: fill result array
        Message[] memory out = new Message[](encryptedCount);
        uint256 outIndex = 0;
        scanned = 0;
        for (uint256 i = start; i < total && scanned < count; i++) {
            if (_messages[i].kind == 1) {
                out[outIndex] = _messages[i];
                outIndex++;
            }
            scanned++;
        }

        return out;
    }

    /**
     * @notice Set whether large group allows plaintext messages
     * @dev Only owner can call
     */
    function setCommunityPlaintextEnabled(bool on) external onlyOwner { 
        plaintextEnabled = on; 
    }

    /**
     * @notice Set maximum bytes for large group messages
     * @dev Only owner can call
     */
    function setCommunityMessageMaxBytes(uint32 n) external onlyOwner { 
        require(n > 0, "BadMax"); 
        communityMessageMaxBytes = n; 
    }

    /* ===================== RSA Group Chat Public Key ===================== */
    /**
     * @notice Set RSA group chat public key
     * @dev Only owner can call, automatically increments groupKeyEpoch
     * @param newKey New RSA public key (PEM or Base64 format)
     * @param metadataHash Metadata hash
     */
    function setRsaGroupPublicKey(string calldata newKey, bytes32 metadataHash) external onlyOwner {
        rsaGroupPublicKey = newKey;
        groupKeyEpoch += 1;
        emit RsaGroupPublicKeyUpdated(groupKeyEpoch, newKey);
        emit GroupKeyEpochIncreased(groupKeyEpoch, metadataHash);
    }

    /**
     * @notice Get RSA group chat public key
     */
    function getRsaGroupPublicKey() external view returns (string memory) { 
        return rsaGroupPublicKey; 
    }

    /**
     * @notice Get group key epoch version
     */
    function getGroupKeyEpoch() external view returns (uint64) { 
        return groupKeyEpoch; 
    }

    /* ===================== Room Management ===================== */
    /**
     * @notice Create room
     * @dev Only active members can create rooms
     *      Requires payment of fixed creation fee (default 50 UNICHAT)
     *      Uses EIP-1167 clone pattern to create Room instances
     *      Room parameters use default values set by large group, message limit fixed at 2048 bytes
     */
    function createRoom() external onlyActiveMember whenNotPaused returns (address room) {
        // Deduct creation fee from creator and transfer to treasury (using SafeERC20)
        UNICHAT.safeTransferFrom(msg.sender, treasury, roomCreateFee);

        // Clone Room implementation contract
        room = Clones.clone(roomImplementation);
        
        // Initialize cloned Room instance with default parameters set by large group
        IRoom(room).initialize(
            msg.sender,
            address(UNICHAT),
            address(this),
            defaultInviteFee,
            defaultPlaintextEnabled,
            MESSAGE_MAX_BYTES  // Fixed at 2048 bytes
        );

        rooms.push(room);
        emit RoomCreated(room, msg.sender, defaultInviteFee);
    }
    
    /**
     * @notice Set default room parameters
     * @dev Only large group owner can call, affects all subsequently created rooms
     * @param _defaultInviteFee Default invite fee
     * @param _defaultPlaintextEnabled Default whether plaintext messages are enabled
     */
    function setDefaultRoomParams(uint256 _defaultInviteFee, bool _defaultPlaintextEnabled) external onlyOwner {
        defaultInviteFee = _defaultInviteFee;
        defaultPlaintextEnabled = _defaultPlaintextEnabled;
        emit DefaultRoomParamsUpdated(_defaultInviteFee, _defaultPlaintextEnabled);
    }

    /**
     * @notice Get number of created rooms
     */
    function roomsCount() external view returns (uint256) { return rooms.length; }
    
    /**
     * @notice Batch get room address list
     * @dev Paginated query, returns room addresses in range [start, start+count)
     * @param start Starting index
     * @param count Query count
     */
    function getRooms(uint256 start, uint256 count) external view returns (address[] memory) {
        uint256 totalRooms = rooms.length;
        
        // If starting position out of range, return empty array
        if (start >= totalRooms) {
            return new address[](0);
        }
        
        // Calculate actual return count
        uint256 end = start + count;
        if (end > totalRooms) {
            end = totalRooms;
        }
        uint256 actualCount = end - start;
        
        // Create return array and fill data
        address[] memory result = new address[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = rooms[start + i];
        }
        
        return result;
    }

    /* ===================== Member Queries ===================== */
    /**
     * @notice Get total number of large group members (includes all historical members)
     * @return Total member count
     */
    function getMembersCount() external view returns (uint256) {
        return membersCount;
    }

    /**
     * @notice Get member address list with pagination (includes all historical members)
     * @dev Paginated query, returns member addresses in range [start, start+count)
     *      Note: This function returns all members who have ever joined, including those no longer in current epoch whitelist
     * @param start Starting index
     * @param count Query count
     * @return Member address array
     */
    function getMembers(uint256 start, uint256 count) external view returns (address[] memory) {
        uint256 totalMembers = members.length;
        
        // If starting position out of range, return empty array
        if (start >= totalMembers) {
            return new address[](0);
        }
        
        // Calculate actual return count
        uint256 end = start + count;
        if (end > totalMembers) {
            end = totalMembers;
        }
        uint256 actualCount = end - start;
        
        // Create return array and fill data
        address[] memory result = new address[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = members[start + i];
        }
        
        return result;
    }

    /**
     * @notice Get current active member count (only counts members in current epoch)
     * @dev Only counts members where lastJoinedEpoch == currentEpoch
     * @return Active member count
     */
    function getActiveMembersCount() external view returns (uint256) {
        uint256 count = 0;
        uint256 total = members.length;
        for (uint256 i = 0; i < total; i++) {
            if (isMember[members[i]] && lastJoinedEpoch[members[i]] == currentEpoch) {
                count++;
            }
        }
        return count;
    }

    /**
     * @notice Get current active member address list with pagination (only current epoch members)
     * @dev Paginated query, only returns members where lastJoinedEpoch == currentEpoch
     *      This function iterates through all historical members and filters active ones, may consume more gas
     * @param start Starting index (based on active member list)
     * @param count Query count
     * @return Active member address array
     */
    function getActiveMembers(uint256 start, uint256 count) external view returns (address[] memory) {
        // First pass: collect all active member addresses
        address[] memory activeList = new address[](members.length);
        uint256 activeCount = 0;
        uint256 total = members.length;
        
        for (uint256 i = 0; i < total; i++) {
            address member = members[i];
            if (isMember[member] && lastJoinedEpoch[member] == currentEpoch) {
                activeList[activeCount] = member;
                activeCount++;
            }
        }
        
        // If starting position out of range, return empty array
        if (start >= activeCount) {
            return new address[](0);
        }
        
        // Calculate actual return count
        uint256 end = start + count;
        if (end > activeCount) {
            end = activeCount;
        }
        uint256 actualCount = end - start;
        
        // Create return array and fill data
        address[] memory result = new address[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = activeList[start + i];
        }
        
        return result;
    }

    /* ===================== Admin Functions ===================== */
    /**
     * @notice Pause contract
     * @dev Only owner can call, after pausing, joining and creating rooms are prohibited
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause contract
     * @dev Only owner can call
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Transfer large group ownership
     * @dev Only current owner can call, new owner cannot be zero address
     * @param newOwner New owner address
     */
    function transferCommunityOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZeroAddr");
        address oldOwner = owner();
        _transferOwnership(newOwner);
        emit CommunityOwnershipTransferred(oldOwner, newOwner);
    }

    /**
     * @notice Set red packet contract address (can only be set once)
     * @dev Only owner can call
     * @param redPacket_ Red packet contract address
     */
    function setRedPacket(address redPacket_) external onlyOwner {
        require(address(redPacket) == address(0), "already set");
        require(redPacket_ != address(0), "ZeroAddr");
        redPacket = IUniChatRedPacket(redPacket_);
    }

    /* ===================== Key Distribution Functions ===================== */
    /**
     * @notice Owner distributes group key
     * @dev Only owner can call
     *      Frontend flow:
     *      1. Call getActiveMembers to get all active member addresses
     *      2. Encrypt group key for each member using their public key
     *      3. Build Merkle Tree using merkletreejs (leaf node: keccak256(address, encryptedKey))
     *      4. Upload complete encrypted key file to IPFS
     *      5. Call this function, pass Merkle Root and IPFS CID
     * @param merkleRoot Merkle Root of member addresses and encrypted keys
     * @param ipfsCid IPFS file CID (stores encrypted keys for all members)
     */
    function distributeGroupKey(bytes32 merkleRoot, string calldata ipfsCid) external onlyOwner whenNotPaused {
        require(merkleRoot != bytes32(0), "ZeroRoot");
        require(bytes(ipfsCid).length > 0, "EmptyCid");

        currentDistributionEpoch += 1;
        
        keyDistributions[currentDistributionEpoch] = KeyDistribution({
            merkleRoot: merkleRoot,
            ipfsCid: ipfsCid,
            distributionEpoch: currentDistributionEpoch,
            timestamp: uint40(block.timestamp)
        });

        emit KeyDistributed(currentDistributionEpoch, merkleRoot, ipfsCid, uint40(block.timestamp));
    }

    /**
     * @notice Get key distribution information for specified version
     * @param distributionEpoch Distribution version number
     * @return merkleRoot Merkle Root
     * @return ipfsCid IPFS CID
     * @return epoch Distribution version number
     * @return timestamp Distribution timestamp
     */
    function getKeyDistribution(uint64 distributionEpoch) external view returns (
        bytes32 merkleRoot,
        string memory ipfsCid,
        uint64 epoch,
        uint40 timestamp
    ) {
        KeyDistribution storage kd = keyDistributions[distributionEpoch];
        return (kd.merkleRoot, kd.ipfsCid, kd.distributionEpoch, kd.timestamp);
    }

    /**
     * @notice Get latest key distribution information
     * @return merkleRoot Merkle Root
     * @return ipfsCid IPFS CID
     * @return epoch Distribution version number
     * @return timestamp Distribution timestamp
     */
    function getLatestKeyDistribution() external view returns (
        bytes32 merkleRoot,
        string memory ipfsCid,
        uint64 epoch,
        uint40 timestamp
    ) {
        if (currentDistributionEpoch == 0) {
            return (bytes32(0), "", uint64(0), uint40(0));
        }
        KeyDistribution storage kd = keyDistributions[currentDistributionEpoch];
        return (kd.merkleRoot, kd.ipfsCid, kd.distributionEpoch, kd.timestamp);
    }

    /**
     * @notice Verify if user's encrypted key is in Merkle Tree
     * @dev For frontend use: user downloads IPFS file, extracts their encrypted key, verifies if in Merkle Tree
     * @param distributionEpoch Distribution version number
     * @param account User address
     * @param encryptedKey Encrypted group key (frontend gets from IPFS)
     * @param proof Merkle Proof
     * @return Whether verification passed
     */
    function verifyEncryptedKey(
        uint64 distributionEpoch,
        address account,
        bytes calldata encryptedKey,
        bytes32[] calldata proof
    ) external view returns (bool) {
        KeyDistribution storage kd = keyDistributions[distributionEpoch];
        if (kd.merkleRoot == bytes32(0)) return false;
        
        bytes32 leaf = keccak256(abi.encodePacked(account, encryptedKey));
        return proof.verify(kd.merkleRoot, leaf);
    }
}
