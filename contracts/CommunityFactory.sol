// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Community 合约初始化接口
 */
interface ICommunity {
    function initialize(
        address communityOwner,
        address feeToken,            // 用于支付房间创建费的代币（UNICHAT）
        address treasury,
        uint256 roomCreateFee,
        address roomImplementation,

        // === 新增：主题代币 & 唯一键 & 元数据 ===
        address topicToken,          // 这个大群绑定的"主题代币"
        uint8   maxTier,             // 1..7
        string calldata name_,       // 群名称
        string calldata avatarCid_   // 头像CID
    ) external;
}

/**
 * @title CommunityFactory
 * @notice 创建大群（Community）并保证 (topicToken, maxTier) 全局唯一
 * @dev 使用 EIP-1167 最小代理模式克隆 Community 实例，节省部署 gas
 */
contract CommunityFactory is Ownable, Pausable {
    /* ===================== 事件 ===================== */
    /// @notice 当创建新的大群时触发
    event CommunityCreated(address indexed community, address indexed owner, address indexed topicToken, uint8 maxTier);
    
    /// @notice 当更新实现合约地址时触发
    event ImplementationsUpdated(address communityImpl, address roomImpl);
    
    /// @notice 当更新小群创建费时触发
    event RoomCreateFeeUpdated(uint256 newFee);
    
    /// @notice 当更新金库地址时触发
    event TreasuryUpdated(address newTreasury);

    /* ===================== 状态变量 ===================== */
    /// @notice 费用代币合约地址（不可变）
    IERC20 public immutable UNICHAT;
    
    /// @notice 费用接收金库地址
    address public treasury;
    
    /// @notice 小群固定创建费（单位：wei，例如 50e18）
    uint256 public roomCreateFee;

    /// @notice Community 实现合约地址（用于克隆）
    address public communityImplementation;
    
    /// @notice Room 实现合约地址（用于克隆）
    address public roomImplementation;

    /// @notice (topicToken, maxTier) -> Community 地址，保证唯一
    mapping(bytes32 => address) private _communityByTokenTier;

    /* ===================== 构造函数 ===================== */
    /**
     * @notice 构造函数，初始化工厂合约
     * @dev 设置部署者为合约 owner，初始化全局参数
     */
    constructor(
        address unichatToken,
        address _treasury,
        uint256 _roomCreateFee,
        address _communityImpl,
        address _roomImpl
    ) Ownable(msg.sender) {
        // 验证关键地址不为零地址
        require(unichatToken != address(0) && _treasury != address(0), "ZeroAddr");
        require(_communityImpl != address(0) && _roomImpl != address(0), "ImplNotSet");
        
        UNICHAT = IERC20(unichatToken);
        treasury = _treasury;
        roomCreateFee = _roomCreateFee;
        communityImplementation = _communityImpl;
        roomImplementation = _roomImpl;
    }

    /* ===================== 管理员函数 ===================== */
    /**
     * @notice 更新实现合约地址
     * @dev 只有 owner 可以调用，用于升级实现合约逻辑
     */
    function setImplementations(address _communityImpl, address _roomImpl) external onlyOwner {
        require(_communityImpl != address(0) && _roomImpl != address(0), "ZeroAddr");
        communityImplementation = _communityImpl;
        roomImplementation = _roomImpl;
        emit ImplementationsUpdated(_communityImpl, _roomImpl);
    }

    /**
     * @notice 更新小群创建费
     * @dev 只有 owner 可以调用
     */
    function setRoomCreateFee(uint256 newFee) external onlyOwner {
        roomCreateFee = newFee;
        emit RoomCreateFeeUpdated(newFee);
    }

    /**
     * @notice 更新金库地址
     * @dev 只有 owner 可以调用，新地址不能为零地址
     */
    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "ZeroAddr");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /* ===================== 读取 ===================== */
    /**
     * @notice 根据 (topicToken, maxTier) 查询对应的 Community 地址
     * @dev 如果返回零地址，说明该组合尚未创建
     */
    function getCommunityByTokenTier(address topicToken, uint8 maxTier) external view returns (address) {
        return _communityByTokenTier[_key(topicToken, maxTier)];
    }

    /* ===================== 核心函数 ===================== */
    /**
     * @notice 创建新的大群（唯一键：topicToken + maxTier）
     * @dev 仅系统管理员可创建大群，并指定大群群主
     *      使用 EIP-1167 克隆模式创建 Community 实例
     *      保证 (topicToken, maxTier) 全局唯一
     */
    function createCommunity(
        address communityOwner,
        address topicToken,
        uint8   maxTier,            // 1..7
        string calldata name_,
        string calldata avatarCid_
    ) external onlyOwner whenNotPaused returns (address community) {
        require(communityImplementation != address(0) && roomImplementation != address(0), "ImplNotSet");
        require(communityOwner != address(0) && topicToken != address(0), "ZeroAddr");
        require(maxTier >= 1 && maxTier <= 7, "BadTier");

        bytes32 k = _key(topicToken, maxTier);
        require(_communityByTokenTier[k] == address(0), "CommunityExists");

        // 使用最小代理模式克隆 Community 合约
        community = Clones.clone(communityImplementation);
        
        // 初始化克隆的 Community 实例
        ICommunity(community).initialize(
            communityOwner,
            address(UNICHAT),
            treasury,
            roomCreateFee,
            roomImplementation,
            topicToken,
            maxTier,
            name_,
            avatarCid_
        );

        _communityByTokenTier[k] = community;
        emit CommunityCreated(community, communityOwner, topicToken, maxTier);
    }

    /* ===================== 内部函数 ===================== */
    /**
     * @notice 计算 (topicToken, maxTier) 的唯一键
     */
    function _key(address token, uint8 tier) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(token, tier));
    }

    /* ===================== 暂停 ===================== */
    /**
     * @notice 暂停工厂合约
     * @dev 只有系统管理员可以调用，暂停后禁止创建新的大群
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice 恢复工厂合约
     * @dev 只有系统管理员可以调用
     */
    function unpause() external onlyOwner {
        _unpause();
    }
}
