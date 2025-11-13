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

    function eligible(
        address account,
        uint256 _maxTier,
        uint256 epoch,
        uint256 validUntil,
        bytes32 nonce,
        bytes32[] calldata proof
    ) external view returns (bool);

    function topicToken() external view returns (address);
    function maxTier() external view returns (uint8);
    function name_() external view returns (string memory);
    function avatarCid() external view returns (string memory);
    function owner() external view returns (address);
    function currentEpoch() external view returns (uint256);
}

/**
 * @title CommunityFactory
 * @notice 创建大群（Community）并保证 (topicToken, maxTier) 全局唯一
 * @dev 使用 EIP-1167 最小代理模式克隆 Community 实例，节省部署 gas
 */
contract CommunityFactory is Ownable, Pausable {
    /* ===================== 结构体 ===================== */
    /**
     * @notice 群聊元数据结构体
     */
    struct CommunityMetadata {
        address communityAddress;   // 群聊合约地址
        address owner;              // 群主地址
        address topicToken;         // 主题代币地址
        uint8 maxTier;              // 最大档位 (1-7)
        string name;                // 群名称
        string avatarCid;           // 头像 CID
        uint256 currentEpoch;       // 当前 epoch 版本
    }

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

    /// @notice 所有创建的 Community 地址列表
    address[] private _allCommunities;

    /// @notice 按主题代币分类存储的 Community 地址
    mapping(address => address[]) private _communitiesByTopic;

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

    /**
     * @notice 获取所有群聊总数
     */
    function getAllCommunitiesCount() external view returns (uint256) {
        return _allCommunities.length;
    }

    /**
     * @notice 分页获取群聊列表
     * @param start 起始索引
     * @param count 获取数量
     * @return 群聊地址数组
     */
    function getCommunities(uint256 start, uint256 count) external view returns (address[] memory) {
        uint256 total = _allCommunities.length;
        
        // 如果起始位置超出范围，返回空数组
        if (start >= total) {
            return new address[](0);
        }
        
        // 计算实际返回的数量
        uint256 end = start + count;
        if (end > total) {
            end = total;
        }
        uint256 actualCount = end - start;
        
        // 创建返回数组并填充数据
        address[] memory result = new address[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = _allCommunities[start + i];
        }
        
        return result;
    }

    /**
     * @notice 获取指定主题代币的所有群聊
     * @param topicToken 主题代币地址
     * @return 群聊地址数组
     */
    function getCommunitiesByTopic(address topicToken) external view returns (address[] memory) {
        return _communitiesByTopic[topicToken];
    }

    /**
     * @notice 分页获取指定主题代币的群聊
     * @param topicToken 主题代币地址
     * @param start 起始索引
     * @param count 获取数量
     * @return 群聊地址数组
     */
    function getCommunitiesByTopicPaginated(
        address topicToken, 
        uint256 start, 
        uint256 count
    ) external view returns (address[] memory) {
        address[] storage communities = _communitiesByTopic[topicToken];
        uint256 total = communities.length;
        
        // 如果起始位置超出范围，返回空数组
        if (start >= total) {
            return new address[](0);
        }
        
        // 计算实际返回的数量
        uint256 end = start + count;
        if (end > total) {
            end = total;
        }
        uint256 actualCount = end - start;
        
        // 创建返回数组并填充数据
        address[] memory result = new address[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = communities[start + i];
        }
        
        return result;
    }

    /**
     * @notice 批量检查用户是否有资格加入指定的多个群聊
     * @param user 用户地址
     * @param communities 群聊地址数组
     * @param tiers 对应的档位数组
     * @param epochs 对应的 epoch 数组
     * @param validUntils 对应的过期时间数组
     * @param nonces 对应的 nonce 数组
     * @param proofs 对应的 Merkle Proof 数组
     * @return 布尔数组，表示每个群聊的资格状态
     */
    function batchCheckEligibility(
        address user,
        address[] calldata communities,
        uint256[] calldata tiers,
        uint256[] calldata epochs,
        uint256[] calldata validUntils,
        bytes32[] calldata nonces,
        bytes32[][] calldata proofs
    ) external view returns (bool[] memory) {
        require(
            communities.length == tiers.length &&
            communities.length == epochs.length &&
            communities.length == validUntils.length &&
            communities.length == nonces.length &&
            communities.length == proofs.length,
            "LengthMismatch"
        );

        uint256 length = communities.length;
        bool[] memory results = new bool[](length);

        for (uint256 i = 0; i < length; i++) {
            try ICommunity(communities[i]).eligible(
                user,
                tiers[i],
                epochs[i],
                validUntils[i],
                nonces[i],
                proofs[i]
            ) returns (bool eligible_) {
                results[i] = eligible_;
            } catch {
                results[i] = false;
            }
        }

        return results;
    }

    /**
     * @notice 批量获取多个群聊的完整元数据
     * @param communities 群聊地址数组
     * @return 元数据数组
     */
    function batchGetCommunityMetadata(address[] calldata communities) 
        external view returns (CommunityMetadata[] memory) 
    {
        uint256 length = communities.length;
        CommunityMetadata[] memory metadata = new CommunityMetadata[](length);

        for (uint256 i = 0; i < length; i++) {
            metadata[i] = _getCommunityMetadata(communities[i]);
        }

        return metadata;
    }

    /**
     * @notice 获取单个群聊的元数据（内部函数）
     * @param community 群聊地址
     * @return 元数据结构体
     */
    function _getCommunityMetadata(address community) internal view returns (CommunityMetadata memory) {
        // 使用单个 try-catch 来避免嵌套
        try this.getCommunityMetadataExternal(community) returns (CommunityMetadata memory result) {
            return result;
        } catch {
            return _getDefaultMetadata(community);
        }
    }

    /**
     * @notice 外部可调用的元数据获取函数（用于内部 try-catch）
     * @param community 群聊地址
     * @return 元数据结构体
     */
    function getCommunityMetadataExternal(address community) external view returns (CommunityMetadata memory) {
        return CommunityMetadata({
            communityAddress: community,
            owner: ICommunity(community).owner(),
            topicToken: ICommunity(community).topicToken(),
            maxTier: ICommunity(community).maxTier(),
            name: ICommunity(community).name_(),
            avatarCid: ICommunity(community).avatarCid(),
            currentEpoch: ICommunity(community).currentEpoch()
        });
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
        
        // 添加到全局列表和主题代币分类列表
        _allCommunities.push(community);
        _communitiesByTopic[topicToken].push(community);
        
        emit CommunityCreated(community, communityOwner, topicToken, maxTier);
    }

    /* ===================== 内部函数 ===================== */
    /**
     * @notice 计算 (topicToken, maxTier) 的唯一键
     */
    function _key(address token, uint8 tier) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(token, tier));
    }

    /**
     * @notice 获取默认元数据（当查询失败时使用）
     * @param community 群聊地址
     * @return 默认元数据结构体
     */
    function _getDefaultMetadata(address community) internal pure returns (CommunityMetadata memory) {
        return CommunityMetadata({
            communityAddress: community,
            owner: address(0),
            topicToken: address(0),
            maxTier: 0,
            name: "",
            avatarCid: "",
            currentEpoch: 0
        });
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
