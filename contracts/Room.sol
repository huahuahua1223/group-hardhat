// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ICommunityReadonly {
    function isActiveMember(address account) external view returns (bool);
}

/**
 * @title Room
 * @notice 小群：群主可自定义拉人费；任何群成员可发消息（消息总是：事件 + 状态存储）
 */
contract Room {
    using SafeERC20 for IERC20;

    /* ===================== Events ===================== */
    event InviteFeeUpdated(uint256 fee);
    event FeeRecipientUpdated(address recipient);
    event Invited(address indexed user, address indexed inviter, uint256 fee);
    event Joined(address indexed user);
    event Kicked(address indexed user, address indexed by);
    event Left(address indexed user);

    event GroupKeyEpochIncreased(uint64 epoch, bytes32 metadataHash);

    event MessageBroadcasted(
        address indexed room,
        address indexed sender,
        uint8 kind,                // 0: PLAINTEXT, 1: ENCRYPTED
        uint256 indexed seq,
        bytes32 contentHash,
        string cid,
        uint40 ts
    );

    /* ===================== Storage ===================== */
    IERC20 public UNICHAT;
    ICommunityReadonly public COMMUNITY;

    address public owner;
    address public feeRecipient;

    uint256 public inviteFee;
    bool public plaintextEnabled;    // 默认 true
    uint32 public messageMaxBytes;   // 默认 1024

    uint64 public groupKeyEpoch;     // 成员变更即自增
    uint256 public seq;              // 消息序号

    mapping(address => bool) public isMember;
    uint256 public membersCount;

    struct Message {
        address sender;
        uint40 ts;
        uint8 kind;        // 0 plain, 1 encrypted
        bytes content;     // 小于等于 messageMaxBytes
        string cid;        // 可选（IPFS CID 或外部引用）
    }
    Message[] private _messages;

    bool private _initialized;

    /* ===================== Modifiers ===================== */
    modifier onlyOwner() { require(msg.sender == owner, "NotOwner"); _; }
    modifier onlyMember() { require(isMember[msg.sender], "NotMember"); _; }

    /* ===================== Initialize (Clones) ===================== */
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

        // 创建者自动入群
        isMember[_owner] = true;
        membersCount = 1;
        emit Joined(_owner);

        _initialized = true;
    }

    /* ===================== Admin ===================== */
    function setInviteFee(uint256 newFee) external onlyOwner {
        inviteFee = newFee;
        emit InviteFeeUpdated(newFee);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        require(recipient != address(0), "ZeroAddr");
        feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }

    function setPlaintextEnabled(bool on) external onlyOwner {
        plaintextEnabled = on;
    }

    function setMessageMaxBytes(uint32 n) external onlyOwner {
        require(n > 0, "BadMax");
        messageMaxBytes = n;
    }

    /// @notice 手动轮换群密钥（配合链下密钥分发）
    function rotateEpoch(bytes32 metadataHash) external onlyOwner {
        groupKeyEpoch += 1;
        emit GroupKeyEpochIncreased(groupKeyEpoch, metadataHash);
    }

    /* ===================== Members ===================== */
    function invite(address user) external {
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

    /// @notice 使用 EIP-2612 permit 简化授权（若 UNICHAT 支持）
    function inviteWithPermit(
        address user,
        uint256 value,               // 通过 permit 设定的 allowance（>= inviteFee）
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external {
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

    function kick(address user) external onlyOwner {
        require(isMember[user], "NotMember");
        isMember[user] = false;
        membersCount -= 1;
        groupKeyEpoch += 1;
        emit Kicked(user, msg.sender);
        emit GroupKeyEpochIncreased(groupKeyEpoch, bytes32(0));
    }

    function leave() external onlyMember {
        isMember[msg.sender] = false;
        membersCount -= 1;
        groupKeyEpoch += 1;
        emit Left(msg.sender);
        emit GroupKeyEpochIncreased(groupKeyEpoch, bytes32(0));
    }

    /* ===================== Messaging ===================== */
    // kind: 0 PLAINTEXT（需 plaintextEnabled=true），1 ENCRYPTED（密文由前端加密）
    // 总是“事件 + 状态存储”
    function sendMessage(
        uint8 kind,
        bytes calldata content,
        string calldata cid
    ) external onlyMember {
        if (kind == 0) {
            require(plaintextEnabled, "PlaintextOff");
        }
        require(content.length <= messageMaxBytes, "TooLarge");

        seq += 1;
        uint40 ts = uint40(block.timestamp);
        bytes32 contentHash = keccak256(content);

        emit MessageBroadcasted(address(this), msg.sender, kind, seq, contentHash, cid, ts);

        _messages.push(Message({
            sender: msg.sender,
            ts: ts,
            kind: kind,
            content: content,
            cid: cid
        }));
    }

    /* ===================== Reads ===================== */
    function messageCount() external view returns (uint256) {
        return _messages.length;
    }

    function getMessage(uint256 index) external view returns (
        address sender, uint40 ts, uint8 kind, bytes memory content, string memory cid
    ) {
        Message storage m = _messages[index];
        return (m.sender, m.ts, m.kind, m.content, m.cid);
    }
}
