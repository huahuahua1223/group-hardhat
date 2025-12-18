// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Community contract initialization interface
 */
interface ICommunity {
    function initialize(
        address communityOwner,
        address feeToken,            // Token used to pay room creation fee (UNICHAT)
        address treasury,
        uint256 roomCreateFee,
        address roomImplementation,

        // === New: Topic token & unique key & metadata ===
        address topicToken,          // "Topic token" bound to this large group
        uint8   maxTier,             // 1..7
        string calldata name_,       // Group name
        string calldata avatarCid_   // Avatar CID
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
 * @notice Creates large groups (Community) and ensures (topicToken, maxTier) is globally unique
 * @dev Uses EIP-1167 minimal proxy pattern to clone Community instances, saving deployment gas
 */
contract CommunityFactory is Ownable, Pausable {
    /* ===================== Structs ===================== */
    /**
     * @notice Group chat metadata struct
     */
    struct CommunityMetadata {
        address communityAddress;   // Group chat contract address
        address owner;              // Group owner address
        address topicToken;         // Topic token address
        uint8 maxTier;              // Maximum tier (1-7)
        string name;                // Group name
        string avatarCid;           // Avatar CID
        uint256 currentEpoch;       // Current epoch version
    }

    /* ===================== Events ===================== */
    /// @notice Emitted when a new large group is created
    event CommunityCreated(address indexed community, address indexed owner, address indexed topicToken, uint8 maxTier);
    
    /// @notice Emitted when implementation contract addresses are updated
    event ImplementationsUpdated(address communityImpl, address roomImpl);
    
    /// @notice Emitted when room creation fee is updated
    event RoomCreateFeeUpdated(uint256 newFee);
    
    /// @notice Emitted when treasury address is updated
    event TreasuryUpdated(address newTreasury);

    /* ===================== State Variables ===================== */
    /// @notice Fee token contract address (immutable)
    IERC20 public immutable UNICHAT;
    
    /// @notice Fee receiving treasury address
    address public treasury;
    
    /// @notice Fixed room creation fee (unit: wei, e.g. 50e18)
    uint256 public roomCreateFee;

    /// @notice Community implementation contract address (for cloning)
    address public communityImplementation;
    
    /// @notice Room implementation contract address (for cloning)
    address public roomImplementation;

    /// @notice (topicToken, maxTier) -> Community address, ensures uniqueness
    mapping(bytes32 => address) private _communityByTokenTier;

    /// @notice List of all created Community addresses
    address[] private _allCommunities;

    /// @notice Community addresses stored by topic token category
    mapping(address => address[]) private _communitiesByTopic;

    /* ===================== Constructor ===================== */
    /**
     * @notice Constructor, initializes factory contract
     * @dev Sets deployer as contract owner, initializes global parameters
     */
    constructor(
        address unichatToken,
        address _treasury,
        uint256 _roomCreateFee,
        address _communityImpl,
        address _roomImpl
    ) Ownable(msg.sender) {
        // Verify critical addresses are not zero address
        require(unichatToken != address(0) && _treasury != address(0), "ZeroAddr");
        require(_communityImpl != address(0) && _roomImpl != address(0), "ImplNotSet");
        
        UNICHAT = IERC20(unichatToken);
        treasury = _treasury;
        roomCreateFee = _roomCreateFee;
        communityImplementation = _communityImpl;
        roomImplementation = _roomImpl;
    }

    /* ===================== Admin Functions ===================== */
    /**
     * @notice Update implementation contract addresses
     * @dev Only owner can call, used to upgrade implementation contract logic
     */
    function setImplementations(address _communityImpl, address _roomImpl) external onlyOwner {
        require(_communityImpl != address(0) && _roomImpl != address(0), "ZeroAddr");
        communityImplementation = _communityImpl;
        roomImplementation = _roomImpl;
        emit ImplementationsUpdated(_communityImpl, _roomImpl);
    }

    /**
     * @notice Update room creation fee
     * @dev Only owner can call
     */
    function setRoomCreateFee(uint256 newFee) external onlyOwner {
        roomCreateFee = newFee;
        emit RoomCreateFeeUpdated(newFee);
    }

    /**
     * @notice Update treasury address
     * @dev Only owner can call, new address cannot be zero address
     */
    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "ZeroAddr");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /* ===================== Read Functions ===================== */
    /**
     * @notice Query corresponding Community address by (topicToken, maxTier)
     * @dev If zero address is returned, the combination has not been created yet
     */
    function getCommunityByTokenTier(address topicToken, uint8 maxTier) external view returns (address) {
        return _communityByTokenTier[_key(topicToken, maxTier)];
    }

    /**
     * @notice Get total number of all group chats
     */
    function getAllCommunitiesCount() external view returns (uint256) {
        return _allCommunities.length;
    }

    /**
     * @notice Get group chat list with pagination
     * @param start Starting index
     * @param count Number to retrieve
     * @return Group chat address array
     */
    function getCommunities(uint256 start, uint256 count) external view returns (address[] memory) {
        uint256 total = _allCommunities.length;
        
        // If starting position out of range, return empty array
        if (start >= total) {
            return new address[](0);
        }
        
        // Calculate actual return count
        uint256 end = start + count;
        if (end > total) {
            end = total;
        }
        uint256 actualCount = end - start;
        
        // Create return array and fill data
        address[] memory result = new address[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = _allCommunities[start + i];
        }
        
        return result;
    }

    /**
     * @notice Get all group chats for specified topic token
     * @param topicToken Topic token address
     * @return Group chat address array
     */
    function getCommunitiesByTopic(address topicToken) external view returns (address[] memory) {
        return _communitiesByTopic[topicToken];
    }

    /**
     * @notice Get group chats for specified topic token with pagination
     * @param topicToken Topic token address
     * @param start Starting index
     * @param count Number to retrieve
     * @return Group chat address array
     */
    function getCommunitiesByTopicPaginated(
        address topicToken, 
        uint256 start, 
        uint256 count
    ) external view returns (address[] memory) {
        address[] storage communities = _communitiesByTopic[topicToken];
        uint256 total = communities.length;
        
        // If starting position out of range, return empty array
        if (start >= total) {
            return new address[](0);
        }
        
        // Calculate actual return count
        uint256 end = start + count;
        if (end > total) {
            end = total;
        }
        uint256 actualCount = end - start;
        
        // Create return array and fill data
        address[] memory result = new address[](actualCount);
        for (uint256 i = 0; i < actualCount; i++) {
            result[i] = communities[start + i];
        }
        
        return result;
    }

    /**
     * @notice Batch check if user is eligible to join specified multiple group chats
     * @param user User address
     * @param communities Group chat address array
     * @param tiers Corresponding tier array
     * @param epochs Corresponding epoch array
     * @param validUntils Corresponding expiration time array
     * @param nonces Corresponding nonce array
     * @param proofs Corresponding Merkle Proof array
     * @return Boolean array indicating eligibility status for each group chat
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
     * @notice Batch get complete metadata for multiple group chats
     * @param communities Group chat address array
     * @return Metadata array
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
     * @notice Get single group chat metadata (internal function)
     * @param community Group chat address
     * @return Metadata struct
     */
    function _getCommunityMetadata(address community) internal view returns (CommunityMetadata memory) {
        // Use single try-catch to avoid nesting
        try this.getCommunityMetadataExternal(community) returns (CommunityMetadata memory result) {
            return result;
        } catch {
            return _getDefaultMetadata(community);
        }
    }

    /**
     * @notice Externally callable metadata retrieval function (for internal try-catch)
     * @param community Group chat address
     * @return Metadata struct
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

    /* ===================== Core Functions ===================== */
    /**
     * @notice Create new large group (unique key: topicToken + maxTier)
     * @dev Only system admin can create large groups and specify large group owner
     *      Uses EIP-1167 clone pattern to create Community instances
     *      Ensures (topicToken, maxTier) is globally unique
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

        // Use minimal proxy pattern to clone Community contract
        community = Clones.clone(communityImplementation);
        
        // Initialize cloned Community instance
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
        
        // Add to global list and topic token category list
        _allCommunities.push(community);
        _communitiesByTopic[topicToken].push(community);
        
        emit CommunityCreated(community, communityOwner, topicToken, maxTier);
    }

    /* ===================== Internal Functions ===================== */
    /**
     * @notice Calculate unique key for (topicToken, maxTier)
     */
    function _key(address token, uint8 tier) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(token, tier));
    }

    /**
     * @notice Get default metadata (used when query fails)
     * @param community Group chat address
     * @return Default metadata struct
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

    /* ===================== Pause ===================== */
    /**
     * @notice Pause factory contract
     * @dev Only system admin can call, after pausing, creating new large groups is prohibited
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause factory contract
     * @dev Only system admin can call
     */
    function unpause() external onlyOwner {
        _unpause();
    }
}
