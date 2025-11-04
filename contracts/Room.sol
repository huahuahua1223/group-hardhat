// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @notice Community 只读接口，用于验证成员资格
 */
interface ICommunityReadonly {
    function isActiveMember(address account) external view returns (bool);
}

/**
 * @title Room
 * @notice 小群合约，支持自定义邀请费和消息管理
 * @dev 群主可自定义邀请费；任何群成员可发送消息
 *      消息同时存储在事件和状态中，支持明文和密文
 */
contract Room {
    using SafeERC20 for IERC20;

    /* ===================== 事件 ===================== */
    /// @notice 当更新邀请费时触发
    event InviteFeeUpdated(uint256 fee);
    
    /// @notice 当更新费用接收人时触发
    event FeeRecipientUpdated(address recipient);
    
    /// @notice 当邀请新成员时触发
    event Invited(address indexed user, address indexed inviter, uint256 fee);
    
    /// @notice 当成员加入时触发
    event Joined(address indexed user);
    
    /// @notice 当成员被踢出时触发
    event Kicked(address indexed user, address indexed by);
    
    /// @notice 当成员主动离开时触发
    event Left(address indexed user);

    /// @notice 当群密钥 epoch 增加时触发（成员变更时）
    event GroupKeyEpochIncreased(uint64 epoch, bytes32 metadataHash);

    /// @notice 当广播消息时触发
    event MessageBroadcasted(
        address indexed room,
        address indexed sender,
        uint8 kind,                // 0: 明文, 1: 密文
        uint256 indexed seq,
        bytes32 contentHash,
        string cid,
        uint40 ts
    );

    /* ===================== 状态变量 ===================== */
    /// @notice 费用代币合约地址
    IERC20 public UNICHAT;
    
    /// @notice 所属大群合约地址
    ICommunityReadonly public COMMUNITY;

    /// @notice 小群群主地址
    address public owner;
    
    /// @notice 邀请费接收人地址
    address public feeRecipient;

    /// @notice 邀请新成员所需费用
    uint256 public inviteFee;
    
    /// @notice 是否启用明文消息（默认 true）
    bool public plaintextEnabled;
    
    /// @notice 消息最大字节数（默认 1024）
    uint32 public messageMaxBytes;

    /// @notice 群密钥 epoch 版本号（成员变更时自增）
    uint64 public groupKeyEpoch;
    
    /// @notice 消息序号
    uint256 public seq;

    /// @notice 用户是否为小群成员
    mapping(address => bool) public isMember;
    
    /// @notice 小群成员总数
    uint256 public membersCount;

    /**
     * @notice 消息结构体
     */
    struct Message {
        address sender;    // 发送者地址
        uint40 ts;         // 时间戳
        uint8 kind;        // 消息类型：0 明文, 1 密文
        string content;    // 消息内容（字符串形式，小于等于 messageMaxBytes）
        string cid;        // 可选（IPFS CID 或外部引用）
    }
    
    /// @notice 消息存储数组
    Message[] private _messages;

    /// @notice 是否已初始化
    bool private _initialized;

    /* ===================== 修饰器 ===================== */
    /// @notice 只有群主可以调用
    modifier onlyOwner() { require(msg.sender == owner, "NotOwner"); _; }
    
    /// @notice 只有成员可以调用
    modifier onlyMember() { require(isMember[msg.sender], "NotMember"); _; }

    /* ===================== 初始化函数（用于克隆实例） ===================== */
    /**
     * @notice 初始化克隆的 Room 实例
     * @dev 只能调用一次，设置群主和相关参数
     *      创建者自动成为第一个成员
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

        // 创建者自动入群
        isMember[_owner] = true;
        membersCount = 1;
        emit Joined(_owner);

        _initialized = true;
    }

    /* ===================== 管理员函数 ===================== */
    /**
     * @notice 设置邀请费
     * @dev 只有群主可以调用
     */
    function setInviteFee(uint256 newFee) external onlyOwner {
        inviteFee = newFee;
        emit InviteFeeUpdated(newFee);
    }

    /**
     * @notice 设置费用接收人
     * @dev 只有群主可以调用，新地址不能为零地址
     */
    function setFeeRecipient(address recipient) external onlyOwner {
        require(recipient != address(0), "ZeroAddr");
        feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }

    /**
     * @notice 设置是否启用明文消息
     * @dev 只有群主可以调用
     */
    function setPlaintextEnabled(bool on) external onlyOwner {
        plaintextEnabled = on;
    }

    /**
     * @notice 设置消息最大字节数
     * @dev 只有群主可以调用，必须大于 0
     */
    function setMessageMaxBytes(uint32 n) external onlyOwner {
        require(n > 0, "BadMax");
        messageMaxBytes = n;
    }

    /**
     * @notice 手动轮换群密钥
     * @dev 只有群主可以调用，配合链下密钥分发使用
     *      通常在成员变更后调用，更新群密钥 epoch
     */
    function rotateEpoch(bytes32 metadataHash) external onlyOwner {
        groupKeyEpoch += 1;
        emit GroupKeyEpochIncreased(groupKeyEpoch, metadataHash);
    }

    /* ===================== 成员管理 ===================== */
    /**
     * @notice 邀请新成员加入小群
     * @dev 被邀请人必须是大群的活跃成员
     *      邀请人需要支付邀请费（如果设置了费用）
     *      成员变更会自动增加群密钥 epoch
     */
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

    /**
     * @notice 使用 EIP-2612 Permit 邀请新成员
     * @dev 使用链下签名授权，一笔交易完成授权和邀请
     *      被邀请人必须是大群的活跃成员
     *      适用于支持 Permit 的代币（如 UNICHAT）
     */
    function inviteWithPermit(
        address user,
        uint256 value,
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

    /**
     * @notice 踢出成员
     * @dev 只有群主可以调用
     *      成员变更会自动增加群密钥 epoch
     */
    function kick(address user) external onlyOwner {
        require(isMember[user], "NotMember");
        isMember[user] = false;
        membersCount -= 1;
        groupKeyEpoch += 1;
        emit Kicked(user, msg.sender);
        emit GroupKeyEpochIncreased(groupKeyEpoch, bytes32(0));
    }

    /**
     * @notice 主动离开小群
     * @dev 任何成员都可以调用
     *      成员变更会自动增加群密钥 epoch
     */
    function leave() external onlyMember {
        isMember[msg.sender] = false;
        membersCount -= 1;
        groupKeyEpoch += 1;
        emit Left(msg.sender);
        emit GroupKeyEpochIncreased(groupKeyEpoch, bytes32(0));
    }

    /* ===================== 消息功能 ===================== */
    /**
     * @notice 发送消息
     * @dev 只有成员可以调用
     *      消息类型：0 = 明文（需启用 plaintextEnabled），1 = 密文（由前端加密）
     *      消息同时存储在事件和状态中：
     *      - 事件：便宜、易于索引，但合约无法读取
     *      - 状态：可供合约读取，但成本较高
     */
    function sendMessage(
        uint8 kind,
        string calldata content,
        string calldata cid
    ) external onlyMember {
        // 如果是明文消息，检查是否允许
        if (kind == 0) {
            require(plaintextEnabled, "PlaintextOff");
        }
        // 检查消息长度
        require(bytes(content).length <= messageMaxBytes, "TooLarge");

        seq += 1;
        uint40 ts = uint40(block.timestamp);
        bytes32 contentHash = keccak256(bytes(content));

        // 触发消息广播事件（链下索引使用）
        emit MessageBroadcasted(address(this), msg.sender, kind, seq, contentHash, cid, ts);

        // 存储消息到状态（链上读取使用）
        _messages.push(Message({
            sender: msg.sender,
            ts: ts,
            kind: kind,
            content: content,
            cid: cid
        }));
    }

    /* ===================== 查询函数 ===================== */
    /**
     * @notice 获取消息总数
     */
    function messageCount() external view returns (uint256) {
        return _messages.length;
    }

    /**
     * @notice 获取指定索引的消息
     * @dev 从状态存储中读取消息
     */
    function getMessage(uint256 index) external view returns (
        address sender, uint40 ts, uint8 kind, string memory content, string memory cid
    ) {
        Message storage m = _messages[index];
        return (m.sender, m.ts, m.kind, m.content, m.cid);
    }

    /**
     * @notice 分页读取消息历史
     * @dev 返回区间 [start, start+count) 的消息
     *      如果 start+count 超出范围，只返回到最后一条消息
     */
    function getMessages(uint256 start, uint256 count) external view returns (Message[] memory) {
        uint256 totalMessages = _messages.length;
        
        // 如果起始位置超出范围，返回空数组
        if (start >= totalMessages) {
            return new Message[](0);
        }
        
        // 计算实际返回的消息数量
        uint256 end = start + count;
        if (end > totalMessages) {
            end = totalMessages;
        }
        uint256 actualCount = end - start;
        
        // 创建返回数组并填充数据
        Message[] memory result = new Message[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = _messages[start + i];
        }
        
        return result;
    }
}
