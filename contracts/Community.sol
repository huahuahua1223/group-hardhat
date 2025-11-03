// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

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
 * @notice 大群（仅存 Merkle Root + Epoch）；成员需提交 MerkleProof 上链绑定后，方可创建/参与小群
 */
contract Community is Ownable {
    using MerkleProof for bytes32[];

    /* ===================== Events ===================== */
    event MerkleRootUpdated(uint256 indexed epoch, bytes32 root, string uri);
    event Joined(address indexed account, uint256 tier, uint256 epoch);
    event RoomCreated(address indexed room, address indexed owner, uint256 inviteFee);

    /* ===================== Storage ===================== */
    IERC20 public UNICHAT;               // 初始化后不变
    address public treasury;
    uint256 public roomCreateFee;
    address public roomImplementation;

    mapping(uint256 => bytes32) public merkleRoots; // epoch => root
    uint256 public currentEpoch;
    string public lastMerkleURI;

    mapping(address => bool) public isMember;
    mapping(address => uint256) public memberTier;
    mapping(address => uint256) public lastJoinedEpoch;

    address[] public rooms;

    bool private _initialized;

    /* ===================== 构造器（仅用于实现合约本体） ===================== */
    // ✅ 满足 OZ v5：实现合约部署时把 owner 设为部署者；克隆实例再在 initialize() 里重设
    constructor() Ownable(msg.sender) {}

    /* ===================== Modifiers ===================== */
    modifier onlyActiveMember() {
        require(isMember[msg.sender] && lastJoinedEpoch[msg.sender] == currentEpoch, "NotActiveMember");
        _;
    }

    /* ===================== Initialize (for Clones) ===================== */
    function initialize(
        address communityOwner,
        address unichatToken,
        address _treasury,
        uint256 _roomCreateFee,
        address _roomImplementation
    ) external {
        require(!_initialized, "Initialized");
        require(communityOwner != address(0) && unichatToken != address(0) && _treasury != address(0), "ZeroAddr");

        // 克隆实例的真正 owner
        _transferOwnership(communityOwner);

        UNICHAT = IERC20(unichatToken);
        treasury = _treasury;
        roomCreateFee = _roomCreateFee;
        roomImplementation = _roomImplementation;

        _initialized = true;
    }

    /* ===================== Merkle Root mgmt ===================== */
    function setMerkleRoot(bytes32 newRoot, string calldata uri) external onlyOwner {
        require(newRoot != bytes32(0), "ZeroRoot");
        currentEpoch += 1;
        merkleRoots[currentEpoch] = newRoot;
        lastMerkleURI = uri;
        emit MerkleRootUpdated(currentEpoch, newRoot, uri);
    }

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

    function isActiveMember(address account) external view returns (bool) {
        return isMember[account] && lastJoinedEpoch[account] == currentEpoch;
    }

    /* ===================== Rooms ===================== */
    struct RoomInit {
        uint256 inviteFee;
        bool plaintextEnabled;
        uint32 messageMaxBytes;
    }

    function createRoom(RoomInit calldata params) external onlyActiveMember returns (address room) {
        require(UNICHAT.transferFrom(msg.sender, treasury, roomCreateFee), "UNICHAT_TRANSFER_FAIL");

        room = Clones.clone(roomImplementation);
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

    function roomsCount() external view returns (uint256) { return rooms.length; }
}
