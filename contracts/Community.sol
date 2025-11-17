// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @notice Room 合约初始化接口
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
 * @title Community
 * @notice 大群合约，基于 Merkle Tree 的白名单准入机制
 * @dev 仅存储 Merkle Root + Epoch，成员需提交 MerkleProof 上链绑定后才可创建/参与小群
 *      使用 EIP-1167 最小代理模式克隆 Room 实例
 */
contract Community is Ownable, Pausable {
    using MerkleProof for bytes32[];
    using SafeERC20 for IERC20;

    /* ===================== 事件 ===================== */
    /// @notice 当更新 Merkle Root 时触发
    event MerkleRootUpdated(uint256 indexed epoch, bytes32 root, string uri);
    
    /// @notice 当用户加入大群时触发
    event Joined(address indexed account, uint256 tier, uint256 epoch);
    
    // 大群内置消息
    event CommunityMessageBroadcasted(
        address indexed community,
        address indexed sender,
        uint8   kind,          // 0: 明文, 1: 密文
        uint256 indexed seq,
        bytes32 contentHash,
        string  cid,
        uint40  ts
    );

    event DefaultRoomParamsUpdated(uint256 defaultInviteFee, bool defaultPlaintextEnabled);
    event RoomCreated(address indexed room, address indexed owner, uint256 inviteFee);

    // 群聊密钥
    event GroupKeyEpochIncreased(uint64 epoch, bytes32 metadataHash);
    event RsaGroupPublicKeyUpdated(uint64 epoch, string rsaPublicKey);

    // 元数据
    event CommunityMetadataSet(address indexed topicToken, uint8 maxTier, string name, string avatarCid);
    
    /// @notice 当转让大群群主时触发
    event CommunityOwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /* ===================== 状态变量 ===================== */
    /// @notice 费用代币合约地址
    IERC20 public UNICHAT;
    
    /// @notice 金库地址，接收创建小群的费用
    address public treasury;
    
    /// @notice 创建小群所需费用
    uint256 public roomCreateFee;
    
    /// @notice Room 实现合约地址（用于克隆）
    address public roomImplementation;

    /// @notice Merkle Root 映射，epoch => root
    mapping(uint256 => bytes32) public merkleRoots;
    
    /// @notice 当前 epoch 版本号
    uint256 public currentEpoch;
    
    /// @notice 最后一次设置的 Merkle 元数据 URI
    string public lastMerkleURI;

    /// @notice 用户是否为成员
    mapping(address => bool) public isMember;
    
    /// @notice 用户的资产档位
    mapping(address => uint256) public memberTier;
    
    /// @notice 用户最后加入的 epoch
    mapping(address => uint256) public lastJoinedEpoch;

    /// @notice 所有创建的小群地址列表
    address[] public rooms;

    /// @notice 大群成员总数
    uint256 public membersCount;

    /// @notice 所有成员地址列表
    address[] public members;

    /// @notice 是否已初始化（防止重复初始化）
    bool private _initialized;
    
    /// @notice 已使用的 nonce，防止重放攻击（按用户划分作用域）
    mapping(address => mapping(bytes32 => bool)) public usedNonces;
    
    // ========== 新增：大群本体消息 ==========
    struct Message {
        address sender;
        uint40  ts;
        uint8   kind;      // 0 明文, 1 密文
        string  content;   // 明/密文（前端加密）
        string  cid;       // 外部引用（可选）
    }
    Message[] private _messages;
    uint256 public seq;                   // 大群消息序号
    bool    public plaintextEnabled;      // 是否允许明文（默认 true）
    uint32  public communityMessageMaxBytes;  // 默认 2048

    // ========== 新增：RSA 群聊公钥 ==========
    string public rsaGroupPublicKey;      // 前端使用的群聊公钥（PEM/Base64等文本）
    uint64 public groupKeyEpoch;          // 轮换版本

    // ========== 新增：主题代币 & 唯一键 & 元数据 ==========
    address public topicToken;            // 这个大群绑定的主题代币
    uint8   public maxTier;               // 1..7
    string  public name_;                 // 群名称
    string  public avatarCid;             // 头像 CID
    
    /// @notice 小群默认邀请费（大群群主设置）
    uint256 public defaultInviteFee;
    
    /// @notice 小群默认是否启用明文消息（大群群主设置）
    bool public defaultPlaintextEnabled;
    
    /// @notice 消息最大字节数（固定为 2048）
    uint32 public constant MESSAGE_MAX_BYTES = 2048;

    /* ===================== 构造函数 ===================== */
    /**
     * @notice 构造函数（仅用于实现合约本体）
     * @dev 满足 OpenZeppelin v5 要求：实现合约部署时把 owner 设为部署者
     *      克隆实例会在 initialize() 中重新设置 owner
     */
    constructor() Ownable(msg.sender) {
        // 锁死实现合约，防止被人对“实现合约本体”调用 initialize
        _initialized = true;
    }

    /* ===================== 修饰器 ===================== */
    /**
     * @notice 只有活跃成员才能调用
     * @dev 检查调用者是否为成员且 epoch 版本是否匹配
     */
    modifier onlyActiveMember() {
        require(isMember[msg.sender] && lastJoinedEpoch[msg.sender] == currentEpoch, "NotActiveMember");
        _;
    }

    /* ===================== 初始化函数（用于克隆实例） ===================== */
    /**
     * @notice 初始化克隆的 Community 实例
     * @dev 只能调用一次，设置群主和相关参数
     */
    function initialize(
        address communityOwner,
        address unichatToken,
        address _treasury,
        uint256 _roomCreateFee,
        address _roomImplementation,

        // 新增元数据
        address _topicToken,
        uint8   _maxTier,
        string calldata _name,
        string calldata _avatarCid
    ) external {
        require(!_initialized, "Initialized");
        require(communityOwner != address(0) && unichatToken != address(0) && _treasury != address(0), "ZeroAddr");
        require(_topicToken != address(0), "ZeroTopic");
        require(_maxTier >= 1 && _maxTier <= 7, "BadTier");

        // 将克隆实例的 owner 设置为指定的群主
        _transferOwnership(communityOwner);

        UNICHAT = IERC20(unichatToken);
        treasury = _treasury;
        roomCreateFee = _roomCreateFee;
        roomImplementation = _roomImplementation;
        
        // 大群消息默认参数
        plaintextEnabled = true;
        communityMessageMaxBytes = 2048;

        // 主题代币 & 元数据
        topicToken = _topicToken;
        maxTier    = _maxTier;
        name_      = _name;
        avatarCid  = _avatarCid;

        emit CommunityMetadataSet(_topicToken, _maxTier, _name, _avatarCid);
        
        // 设置默认小群参数
        defaultInviteFee = 0;  // 默认免费邀请
        defaultPlaintextEnabled = true;  // 默认启用明文消息

        _initialized = true;
    }

    /* ===================== Merkle Root 管理 ===================== */
    /**
     * @notice 设置新的 Merkle Root
     * @dev 只有群主可以调用，每次设置会自动增加 epoch 版本号
     *      用于更新白名单，所有成员需要用新的 proof 重新加入
     */
    function setMerkleRoot(bytes32 newRoot, string calldata uri) external onlyOwner whenNotPaused {
        require(newRoot != bytes32(0), "ZeroRoot");
        currentEpoch += 1;
        merkleRoots[currentEpoch] = newRoot;
        lastMerkleURI = uri;
        emit MerkleRootUpdated(currentEpoch, newRoot, uri);
    }

    /**
     * @notice 检查用户是否有资格加入大群（只读函数）
     * @dev 用于前端展示，不消耗 gas
     *      验证 epoch、过期时间和 Merkle Proof 是否有效
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
     * @notice 加入大群
     * @dev 用户提交 Merkle Proof 证明自己在白名单中
     *      验证通过后记录成员信息和资产档位
     *      必须使用当前 epoch 的 proof，且不能过期
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
        
        // 防止 nonce 重放攻击（按用户作用域）
        require(!usedNonces[msg.sender][nonce], "NonceUsed");
        usedNonces[msg.sender][nonce] = true;

        // 如果是新成员，添加到成员列表并增加计数
        bool isNewMember = !isMember[msg.sender];
        if (isNewMember) {
            members.push(msg.sender);
            membersCount += 1;
        }

        isMember[msg.sender] = true;
        memberTier[msg.sender] = _maxTier;
        lastJoinedEpoch[msg.sender] = epoch;

        emit Joined(msg.sender, _maxTier, epoch);
    }

    /**
     * @notice 计算 Merkle Tree 叶子节点哈希
     * @dev 公开函数，用于链下生成和链上验证 proof
     *      叶子节点包含：群地址、epoch、用户地址、档位、过期时间、nonce
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
     * @notice 检查用户是否为活跃成员
     * @dev 用户必须已加入且 epoch 版本匹配
     */
    function isActiveMember(address account) external view returns (bool) {
        return isMember[account] && lastJoinedEpoch[account] == currentEpoch;
    }

    /**
     * @notice 获取群聊基础元数据
     * @return topicToken_ 主题代币地址
     * @return maxTier_ 最大档位
     * @return name 群名称
     * @return avatar 头像 CID
     * @return owner_ 群主地址
     * @return epoch 当前 epoch 版本
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

    /* ===================== 大群内置消息 ===================== */
    /**
     * @notice 在大群中发送消息
     * @dev 只有活跃成员可以调用
     *      kind: 0=明文, 1=密文
     */
    function sendCommunityMessage(
        uint8   kind,        // 0=明文,1=密文
        string calldata content,
        string calldata cid
    ) external onlyActiveMember whenNotPaused {
        if (kind == 0) {
            require(plaintextEnabled, "PlaintextOff");
        }
        require(bytes(content).length <= communityMessageMaxBytes, "TooLarge");

        seq += 1;
        uint40 ts = uint40(block.timestamp);
        bytes32 contentHash = keccak256(bytes(content));

        emit CommunityMessageBroadcasted(address(this), msg.sender, kind, seq, contentHash, cid, ts);

        _messages.push(Message({
            sender: msg.sender,
            ts: ts,
            kind: kind,
            content: content,
            cid: cid
        }));
    }

    /**
     * @notice 获取大群消息总数
     */
    function communityMessageCount() external view returns (uint256) {
        return _messages.length;
    }

    /**
     * @notice 获取指定索引的大群消息
     */
    function getCommunityMessage(uint256 index) external view returns (
        address sender, uint40 ts, uint8 kind, string memory content, string memory cid
    ) {
        Message storage m = _messages[index];
        return (m.sender, m.ts, m.kind, m.content, m.cid);
    }

    /**
     * @notice 分页获取大群消息
     * @param start 起始索引
     * @param count 获取数量
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
     * @notice 分页获取大群明文消息（仅返回 kind=0 的消息）
     * @param start 起始索引（基于全部消息数组）
     * @param count 最多获取数量
     * @return 明文消息数组
     */
    function getPlaintextMessages(uint256 start, uint256 count) external view returns (Message[] memory) {
        uint256 total = _messages.length;
        if (start >= total) return new Message[](0);

        // 第一遍：计算明文消息数量
        uint256 plaintextCount = 0;
        uint256 scanned = 0;
        for (uint256 i = start; i < total && scanned < count; i++) {
            if (_messages[i].kind == 0) {
                plaintextCount++;
            }
            scanned++;
        }

        // 第二遍：填充结果数组
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
     * @notice 分页获取大群密文消息（仅返回 kind=1 的消息）
     * @param start 起始索引（基于全部消息数组）
     * @param count 最多获取数量
     * @return 密文消息数组
     */
    function getEncryptedMessages(uint256 start, uint256 count) external view returns (Message[] memory) {
        uint256 total = _messages.length;
        if (start >= total) return new Message[](0);

        // 第一遍：计算密文消息数量
        uint256 encryptedCount = 0;
        uint256 scanned = 0;
        for (uint256 i = start; i < total && scanned < count; i++) {
            if (_messages[i].kind == 1) {
                encryptedCount++;
            }
            scanned++;
        }

        // 第二遍：填充结果数组
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
     * @notice 设置大群是否允许明文消息
     * @dev 只有群主可以调用
     */
    function setCommunityPlaintextEnabled(bool on) external onlyOwner { 
        plaintextEnabled = on; 
    }

    /**
     * @notice 设置大群消息最大字节数
     * @dev 只有群主可以调用
     */
    function setCommunityMessageMaxBytes(uint32 n) external onlyOwner { 
        require(n > 0, "BadMax"); 
        communityMessageMaxBytes = n; 
    }

    /* ===================== RSA 群聊公钥 ===================== */
    /**
     * @notice 设置 RSA 群聊公钥
     * @dev 只有群主可以调用，会自增 groupKeyEpoch
     * @param newKey 新的 RSA 公钥（PEM 或 Base64 格式）
     * @param metadataHash 元数据哈希
     */
    function setRsaGroupPublicKey(string calldata newKey, bytes32 metadataHash) external onlyOwner {
        rsaGroupPublicKey = newKey;
        groupKeyEpoch += 1;
        emit RsaGroupPublicKeyUpdated(groupKeyEpoch, newKey);
        emit GroupKeyEpochIncreased(groupKeyEpoch, metadataHash);
    }

    /**
     * @notice 获取 RSA 群聊公钥
     */
    function getRsaGroupPublicKey() external view returns (string memory) { 
        return rsaGroupPublicKey; 
    }

    /**
     * @notice 获取群密钥 epoch 版本
     */
    function getGroupKeyEpoch() external view returns (uint64) { 
        return groupKeyEpoch; 
    }

    /* ===================== 小群管理 ===================== */
    /**
     * @notice 创建小群
     * @dev 只有活跃成员可以创建小群
     *      需要支付固定创建费（默认 50 UNICHAT）
     *      使用 EIP-1167 克隆模式创建 Room 实例
     *      小群参数使用大群设置的默认值，消息限制固定为 2048 字节
     */
    function createRoom() external onlyActiveMember whenNotPaused returns (address room) {
        // 从创建者扣除创建费并转入金库（使用 SafeERC20）
        UNICHAT.safeTransferFrom(msg.sender, treasury, roomCreateFee);

        // 克隆 Room 实现合约
        room = Clones.clone(roomImplementation);
        
        // 初始化克隆的 Room 实例，使用大群设置的默认参数
        IRoom(room).initialize(
            msg.sender,
            address(UNICHAT),
            address(this),
            defaultInviteFee,
            defaultPlaintextEnabled,
            MESSAGE_MAX_BYTES  // 固定为 2048 字节
        );

        rooms.push(room);
        emit RoomCreated(room, msg.sender, defaultInviteFee);
    }
    
    /**
     * @notice 设置小群默认参数
     * @dev 只有大群群主可以调用，影响后续创建的所有小群
     * @param _defaultInviteFee 默认邀请费用
     * @param _defaultPlaintextEnabled 默认是否启用明文消息
     */
    function setDefaultRoomParams(uint256 _defaultInviteFee, bool _defaultPlaintextEnabled) external onlyOwner {
        defaultInviteFee = _defaultInviteFee;
        defaultPlaintextEnabled = _defaultPlaintextEnabled;
        emit DefaultRoomParamsUpdated(_defaultInviteFee, _defaultPlaintextEnabled);
    }

    /**
     * @notice 获取已创建的小群数量
     */
    function roomsCount() external view returns (uint256) { return rooms.length; }
    
    /**
     * @notice 批量获取小群地址列表
     * @dev 分页查询，返回区间 [start, start+count) 的小群地址
     * @param start 起始索引
     * @param count 查询数量
     */
    function getRooms(uint256 start, uint256 count) external view returns (address[] memory) {
        uint256 totalRooms = rooms.length;
        
        // 如果起始位置超出范围，返回空数组
        if (start >= totalRooms) {
            return new address[](0);
        }
        
        // 计算实际返回的数量
        uint256 end = start + count;
        if (end > totalRooms) {
            end = totalRooms;
        }
        uint256 actualCount = end - start;
        
        // 创建返回数组并填充数据
        address[] memory result = new address[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = rooms[start + i];
        }
        
        return result;
    }

    /* ===================== 成员查询 ===================== */
    /**
     * @notice 获取大群成员总数（包含所有历史成员）
     * @return 成员总数
     */
    function getMembersCount() external view returns (uint256) {
        return membersCount;
    }

    /**
     * @notice 分页获取成员地址列表（包含所有历史成员）
     * @dev 分页查询，返回区间 [start, start+count) 的成员地址
     *      注意：此函数返回所有曾经加入过的成员，包括已不在当前 epoch 白名单中的成员
     * @param start 起始索引
     * @param count 查询数量
     * @return 成员地址数组
     */
    function getMembers(uint256 start, uint256 count) external view returns (address[] memory) {
        uint256 totalMembers = members.length;
        
        // 如果起始位置超出范围，返回空数组
        if (start >= totalMembers) {
            return new address[](0);
        }
        
        // 计算实际返回的数量
        uint256 end = start + count;
        if (end > totalMembers) {
            end = totalMembers;
        }
        uint256 actualCount = end - start;
        
        // 创建返回数组并填充数据
        address[] memory result = new address[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = members[start + i];
        }
        
        return result;
    }

    /**
     * @notice 获取当前活跃成员总数（仅统计当前 epoch 的成员）
     * @dev 只统计 lastJoinedEpoch == currentEpoch 的成员
     * @return 活跃成员总数
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
     * @notice 分页获取当前活跃成员地址列表（仅当前 epoch 的成员）
     * @dev 分页查询，只返回 lastJoinedEpoch == currentEpoch 的成员
     *      此函数会遍历所有历史成员并过滤出活跃成员，可能消耗较多 gas
     * @param start 起始索引（基于活跃成员列表）
     * @param count 查询数量
     * @return 活跃成员地址数组
     */
    function getActiveMembers(uint256 start, uint256 count) external view returns (address[] memory) {
        // 第一遍：收集所有活跃成员地址
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
        
        // 如果起始位置超出范围，返回空数组
        if (start >= activeCount) {
            return new address[](0);
        }
        
        // 计算实际返回的数量
        uint256 end = start + count;
        if (end > activeCount) {
            end = activeCount;
        }
        uint256 actualCount = end - start;
        
        // 创建返回数组并填充数据
        address[] memory result = new address[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = activeList[start + i];
        }
        
        return result;
    }

    /* ===================== 管理员函数 ===================== */
    /**
     * @notice 暂停合约
     * @dev 只有群主可以调用，暂停后禁止加入、创建小群等操作
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice 恢复合约
     * @dev 只有群主可以调用
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice 转让大群群主
     * @dev 只有当前群主可以调用，新群主不能为零地址
     * @param newOwner 新群主地址
     */
    function transferCommunityOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZeroAddr");
        address oldOwner = owner();
        _transferOwnership(newOwner);
        emit CommunityOwnershipTransferred(oldOwner, newOwner);
    }
}
