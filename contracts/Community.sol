// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
contract Community is Ownable {
    using MerkleProof for bytes32[];

    /* ===================== 事件 ===================== */
    /// @notice 当更新 Merkle Root 时触发
    event MerkleRootUpdated(uint256 indexed epoch, bytes32 root, string uri);
    
    /// @notice 当用户加入大群时触发
    event Joined(address indexed account, uint256 tier, uint256 epoch);
    
    /// @notice 当创建新的小群时触发
    event RoomCreated(address indexed room, address indexed owner, uint256 inviteFee);

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

    /// @notice 是否已初始化（防止重复初始化）
    bool private _initialized;

    /* ===================== 构造函数 ===================== */
    /**
     * @notice 构造函数（仅用于实现合约本体）
     * @dev 满足 OpenZeppelin v5 要求：实现合约部署时把 owner 设为部署者
     *      克隆实例会在 initialize() 中重新设置 owner
     */
    constructor() Ownable(msg.sender) {}

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
        address _roomImplementation
    ) external {
        require(!_initialized, "Initialized");
        require(communityOwner != address(0) && unichatToken != address(0) && _treasury != address(0), "ZeroAddr");

        // 将克隆实例的 owner 设置为指定的群主
        _transferOwnership(communityOwner);

        UNICHAT = IERC20(unichatToken);
        treasury = _treasury;
        roomCreateFee = _roomCreateFee;
        roomImplementation = _roomImplementation;

        _initialized = true;
    }

    /* ===================== Merkle Root 管理 ===================== */
    /**
     * @notice 设置新的 Merkle Root
     * @dev 只有群主可以调用，每次设置会自动增加 epoch 版本号
     *      用于更新白名单，所有成员需要用新的 proof 重新加入
     */
    function setMerkleRoot(bytes32 newRoot, string calldata uri) external onlyOwner {
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
        uint256 maxTier,
        uint256 epoch,
        uint256 validUntil,
        bytes32 nonce,
        bytes32[] calldata proof
    ) external view returns (bool) {
        if (epoch != currentEpoch) return false;
        if (validUntil != 0 && block.timestamp > validUntil) return false;
        bytes32 leaf = computeLeaf(address(this), epoch, account, maxTier, validUntil, nonce);
        return proof.verify(merkleRoots[epoch], leaf);
    }

    /**
     * @notice 加入大群
     * @dev 用户提交 Merkle Proof 证明自己在白名单中
     *      验证通过后记录成员信息和资产档位
     *      必须使用当前 epoch 的 proof，且不能过期
     */
    function joinCommunity(
        uint256 maxTier,
        uint256 epoch,
        uint256 validUntil,
        bytes32 nonce,
        bytes32[] calldata proof
    ) external {
        require(epoch == currentEpoch, "EpochMismatch");
        if (validUntil != 0) require(block.timestamp <= validUntil, "ProofExpired");

        bytes32 leaf = computeLeaf(address(this), epoch, msg.sender, maxTier, validUntil, nonce);
        require(proof.verify(merkleRoots[epoch], leaf), "BadProof");

        isMember[msg.sender] = true;
        memberTier[msg.sender] = maxTier;
        lastJoinedEpoch[msg.sender] = epoch;

        emit Joined(msg.sender, maxTier, epoch);
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
        uint256 maxTier,
        uint256 validUntil,
        bytes32 nonce
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(community, epoch, account, maxTier, validUntil, nonce));
    }

    /**
     * @notice 检查用户是否为活跃成员
     * @dev 用户必须已加入且 epoch 版本匹配
     */
    function isActiveMember(address account) external view returns (bool) {
        return isMember[account] && lastJoinedEpoch[account] == currentEpoch;
    }

    /* ===================== 小群管理 ===================== */
    /**
     * @notice 创建小群的初始化参数结构体
     */
    struct RoomInit {
        uint256 inviteFee;        // 邀请费用
        bool plaintextEnabled;    // 是否启用明文消息
        uint32 messageMaxBytes;   // 消息最大字节数
    }

    /**
     * @notice 创建小群
     * @dev 只有活跃成员可以创建小群
     *      需要支付固定创建费（默认 50 UNICHAT）
     *      使用 EIP-1167 克隆模式创建 Room 实例
     */
    function createRoom(RoomInit calldata params) external onlyActiveMember returns (address room) {
        // 从创建者扣除创建费并转入金库
        require(UNICHAT.transferFrom(msg.sender, treasury, roomCreateFee), "UNICHAT_TRANSFER_FAIL");

        // 克隆 Room 实现合约
        room = Clones.clone(roomImplementation);
        
        // 初始化克隆的 Room 实例
        IRoom(room).initialize(
            msg.sender,
            address(UNICHAT),
            address(this),
            params.inviteFee,
            params.plaintextEnabled,
            params.messageMaxBytes == 0 ? 1024 : params.messageMaxBytes
        );

        rooms.push(room);
        emit RoomCreated(room, msg.sender, params.inviteFee);
    }

    /**
     * @notice 获取已创建的小群数量
     */
    function roomsCount() external view returns (uint256) { return rooms.length; }
}
