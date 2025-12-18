// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @notice Community read-only interface for verifying membership
 */
interface ICommunityReadonly {
    function isActiveMember(address account) external view returns (bool);
}

/**
 * @title Room
 * @notice Room contract supporting custom invite fees and message management
 * @dev Owner can customize invite fee; any room member can send messages
 *      Messages are stored in both events and state, supporting plaintext and ciphertext
 *      Room functionality remains unchanged, fully compatible with new Community interface
 */
contract Room is Pausable {
    using SafeERC20 for IERC20;

    /* ===================== Events ===================== */
    /// @notice Emitted when invite fee is updated
    event InviteFeeUpdated(uint256 fee);
    
    /// @notice Emitted when fee recipient is updated
    event FeeRecipientUpdated(address recipient);
    
    /// @notice Emitted when a new member is invited
    event Invited(address indexed user, address indexed inviter, uint256 fee);
    
    /// @notice Emitted when a member joins
    event Joined(address indexed user);
    
    /// @notice Emitted when a member is kicked
    event Kicked(address indexed user, address indexed by);
    
    /// @notice Emitted when a member leaves voluntarily
    event Left(address indexed user);

    /// @notice Emitted when group key epoch increases (when members change)
    event GroupKeyEpochIncreased(uint64 epoch, bytes32 metadataHash);
    
    /// @notice Emitted when room ownership is transferred
    event RoomOwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Emitted when message is broadcast
    event MessageBroadcasted(
        address indexed room,
        address indexed sender,
        uint8 kind,                // 0: plaintext, 1: ciphertext
        uint256 indexed seq,
        bytes32 contentHash,
        string cid,
        uint40 ts
    );

    /* ===================== State Variables ===================== */
    /// @notice Fee token contract address
    IERC20 public UNICHAT;
    
    /// @notice Parent large group contract address
    ICommunityReadonly public COMMUNITY;

    /// @notice Room owner address
    address public owner;
    
    /// @notice Invite fee recipient address
    address public feeRecipient;

    /// @notice Fee required to invite new member
    uint256 public inviteFee;
    
    /// @notice Whether plaintext messages are enabled (default true)
    bool public plaintextEnabled;
    
    /// @notice Maximum message bytes (default 1024)
    uint32 public messageMaxBytes;

    /// @notice Group key epoch version number (auto-increments when members change)
    uint64 public groupKeyEpoch;
    
    /// @notice Message sequence number
    uint256 public seq;

    /// @notice Whether user is a room member
    mapping(address => bool) public isMember;
    
    /// @notice Total number of room members
    uint256 public membersCount;

    /**
     * @notice Message struct
     */
    struct Message {
        address sender;    // Sender address
        uint40 ts;         // Timestamp
        uint8 kind;        // Message type: 0 plaintext, 1 ciphertext
        string content;    // Message content (string form, less than or equal to messageMaxBytes)
        string cid;        // Optional (IPFS CID or external reference)
    }
    
    /// @notice Message storage array
    Message[] private _messages;

    /// @notice Whether initialized
    bool private _initialized;

    /* ===================== Modifiers ===================== */
    /// @notice Only owner can call
    modifier onlyOwner() { require(msg.sender == owner, "NotOwner"); _; }
    
    /// @notice Only members can call
    modifier onlyMember() { require(isMember[msg.sender], "NotMember"); _; }

    /* ===================== Constructor ===================== */
    /**
     * @notice Constructor, locks implementation contract
     * @dev Prevents calling initialize on implementation contract itself
     *      Only instances created through cloning can be properly initialized
     */
    constructor() {
        // Lock implementation contract to prevent calling initialize on "implementation contract itself"
        _initialized = true;
    }

    /* ===================== Initialization Function (for cloned instances) ===================== */
    /**
     * @notice Initialize cloned Room instance
     * @dev Can only be called once, sets owner and related parameters
     *      Creator automatically becomes first member
     */
    function initialize(
        address _owner,
        address unichatToken,
        address community,
        uint256 _inviteFee,
        bool _plaintextEnabled,
        uint32 _messageMaxBytes
    ) external {
        require(!_initialized, "Initialized");
        require(_owner != address(0) && unichatToken != address(0) && community != address(0), "ZeroAddr");

        owner = _owner;
        feeRecipient = _owner;
        UNICHAT = IERC20(unichatToken);
        COMMUNITY = ICommunityReadonly(community);

        inviteFee = _inviteFee;
        plaintextEnabled = _plaintextEnabled;
        messageMaxBytes = _messageMaxBytes == 0 ? 1024 : _messageMaxBytes;

        // Creator automatically joins room
        isMember[_owner] = true;
        membersCount = 1;
        emit Joined(_owner);

        _initialized = true;
    }

    /* ===================== Admin Functions ===================== */
    /**
     * @notice Set invite fee
     * @dev Only owner can call
     */
    function setInviteFee(uint256 newFee) external onlyOwner {
        inviteFee = newFee;
        emit InviteFeeUpdated(newFee);
    }

    /**
     * @notice Set fee recipient
     * @dev Only owner can call, new address cannot be zero address
     */
    function setFeeRecipient(address recipient) external onlyOwner {
        require(recipient != address(0), "ZeroAddr");
        feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }

    /**
     * @notice Set whether plaintext messages are enabled
     * @dev Only owner can call
     */
    function setPlaintextEnabled(bool on) external onlyOwner {
        plaintextEnabled = on;
    }

    /**
     * @notice Set maximum message bytes
     * @dev Only owner can call, must be greater than 0
     */
    function setMessageMaxBytes(uint32 n) external onlyOwner {
        require(n > 0, "BadMax");
        messageMaxBytes = n;
    }

    /**
     * @notice Manually rotate group key
     * @dev Only owner can call, used with off-chain key distribution
     *      Usually called after member changes to update group key epoch
     */
    function rotateEpoch(bytes32 metadataHash) external onlyOwner {
        groupKeyEpoch += 1;
        emit GroupKeyEpochIncreased(groupKeyEpoch, metadataHash);
    }

    /* ===================== Member Management ===================== */
    /**
     * @notice Invite new member to join room
     * @dev Invited person must be an active member of the large group
     *      Inviter needs to pay invite fee (if fee is set)
     *      Member changes automatically increment group key epoch
     */
    function invite(address user) external whenNotPaused {
        require(user != address(0), "ZeroAddr");
        require(!isMember[user], "AlreadyMember");
        require(COMMUNITY.isActiveMember(user), "NotCommunityMember");

        if (inviteFee > 0) {
            UNICHAT.safeTransferFrom(msg.sender, feeRecipient, inviteFee);
        }

        isMember[user] = true;
        membersCount += 1;

        groupKeyEpoch += 1;

        emit Invited(user, msg.sender, inviteFee);
        emit Joined(user);
        emit GroupKeyEpochIncreased(groupKeyEpoch, bytes32(0));
    }

    /**
     * @notice Invite new member using EIP-2612 Permit
     * @dev Uses off-chain signature authorization, completes authorization and invitation in one transaction
     *      Invited person must be an active member of the large group
     *      Applicable to tokens supporting Permit (such as UNICHAT)
     */
    function inviteWithPermit(
        address user,
        uint256 value,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external whenNotPaused {
        require(user != address(0), "ZeroAddr");
        require(!isMember[user], "AlreadyMember");
        require(COMMUNITY.isActiveMember(user), "NotCommunityMember");

        if (inviteFee > 0) {
            IERC20Permit(address(UNICHAT)).permit(msg.sender, address(this), value, deadline, v, r, s);
            require(value >= inviteFee, "PermitTooLow");
            UNICHAT.safeTransferFrom(msg.sender, feeRecipient, inviteFee);
        }

        isMember[user] = true;
        membersCount += 1;

        groupKeyEpoch += 1;

        emit Invited(user, msg.sender, inviteFee);
        emit Joined(user);
        emit GroupKeyEpochIncreased(groupKeyEpoch, bytes32(0));
    }

    /**
     * @notice Kick member
     * @dev Only owner can call
     *      Member changes automatically increment group key epoch
     *      Owner cannot kick themselves
     */
    function kick(address user) external onlyOwner whenNotPaused {
        require(user != owner, "CannotKickOwner");
        require(isMember[user], "NotMember");
        isMember[user] = false;
        membersCount -= 1;
        groupKeyEpoch += 1;
        emit Kicked(user, msg.sender);
        emit GroupKeyEpochIncreased(groupKeyEpoch, bytes32(0));
    }

    /**
     * @notice Leave room voluntarily
     * @dev Any member can call
     *      Member changes automatically increment group key epoch
     */
    function leave() external onlyMember whenNotPaused {
        isMember[msg.sender] = false;
        membersCount -= 1;
        groupKeyEpoch += 1;
        emit Left(msg.sender);
        emit GroupKeyEpochIncreased(groupKeyEpoch, bytes32(0));
    }

    /* ===================== Message Functions ===================== */
    /**
     * @notice Send message
     * @dev Only members can call
     *      Message type: 0 = plaintext (requires plaintextEnabled), 1 = ciphertext (encrypted by frontend)
     *      Messages are stored in both events and state:
     *      - Events: Cheap, easy to index, but contracts cannot read
     *      - State: Can be read by contracts, but higher cost
     */
    function sendMessage(
        uint8 kind,
        string calldata content,
        string calldata cid
    ) external onlyMember whenNotPaused {
        // If plaintext message, check if allowed
        if (kind == 0) {
            require(plaintextEnabled, "PlaintextOff");
        }
        // Check message length
        require(bytes(content).length <= messageMaxBytes, "TooLarge");

        seq += 1;
        uint40 ts = uint40(block.timestamp);
        bytes32 contentHash = keccak256(bytes(content));

        // Emit message broadcast event (for off-chain indexing)
        emit MessageBroadcasted(address(this), msg.sender, kind, seq, contentHash, cid, ts);

        // Store message in state (for on-chain reading)
        _messages.push(Message({
            sender: msg.sender,
            ts: ts,
            kind: kind,
            content: content,
            cid: cid
        }));
    }

    /* ===================== Query Functions ===================== */
    /**
     * @notice Get total number of messages
     */
    function messageCount() external view returns (uint256) {
        return _messages.length;
    }

    /**
     * @notice Get message at specified index
     * @dev Reads message from state storage
     */
    function getMessage(uint256 index) external view returns (
        address sender, uint40 ts, uint8 kind, string memory content, string memory cid
    ) {
        Message storage m = _messages[index];
        return (m.sender, m.ts, m.kind, m.content, m.cid);
    }

    /**
     * @notice Read message history with pagination
     * @dev Returns messages in range [start, start+count)
     *      If start+count exceeds range, only returns up to last message
     */
    function getMessages(uint256 start, uint256 count) external view returns (Message[] memory) {
        uint256 totalMessages = _messages.length;
        
        // If starting position out of range, return empty array
        if (start >= totalMessages) {
            return new Message[](0);
        }
        
        // Calculate actual number of messages to return
        uint256 end = start + count;
        if (end > totalMessages) {
            end = totalMessages;
        }
        uint256 actualCount = end - start;
        
        // Create return array and fill data
        Message[] memory result = new Message[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = _messages[start + i];
        }
        
        return result;
    }

    /* ===================== Admin Functions ===================== */
    /**
     * @notice Pause contract
     * @dev Only owner can call, after pausing, inviting and sending messages are prohibited
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
     * @notice Transfer room ownership
     * @dev Only current owner can call, new owner cannot be zero address
     *      New owner must be a room member
     * @param newOwner New owner address
     */
    function transferRoomOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZeroAddr");
        require(isMember[newOwner], "NotMember");
        address oldOwner = owner;
        owner = newOwner;
        emit RoomOwnershipTransferred(oldOwner, newOwner);
    }
}
