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
    
    /// @notice 当创建新的小群时触发
    event RoomCreated(address indexed room, address indexed owner, uint256 inviteFee);
    
    /// @notice 当转让大群群主时触发
    event CommunityOwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    
    /// @notice 当更新小群默认参数时触发
    event DefaultRoomParamsUpdated(uint256 defaultInviteFee, bool defaultPlaintextEnabled);

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
    
    /// @notice 已使用的 nonce，防止重放攻击
    mapping(bytes32 => bool) public usedNonces;
    
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
    ) external whenNotPaused {
        require(epoch == currentEpoch, "EpochMismatch");
        if (validUntil != 0) require(block.timestamp <= validUntil, "ProofExpired");

        bytes32 leaf = computeLeaf(address(this), epoch, msg.sender, maxTier, validUntil, nonce);
        require(proof.verify(merkleRoots[epoch], leaf), "BadProof");
        
        // 防止 nonce 重放攻击
        require(!usedNonces[nonce], "NonceUsed");
        usedNonces[nonce] = true;

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
