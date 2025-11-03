// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICommunity {
    function initialize(
        address communityOwner,
        address unichatToken,
        address treasury,
        uint256 roomCreateFee,
        address roomImplementation
    ) external;
}

/**
 * @title CommunityFactory
 * @notice 系统管理员用于创建大群（Community）实例，配置全局参数
 */
contract CommunityFactory is Ownable {
    event CommunityCreated(address indexed community, address indexed owner);
    event ImplementationsUpdated(address communityImpl, address roomImpl);
    event RoomCreateFeeUpdated(uint256 newFee);
    event TreasuryUpdated(address newTreasury);

    IERC20 public immutable UNICHAT;   // 费用代币
    address public treasury;           // 费用接收金库
    uint256 public roomCreateFee;      // 小群固定创建费（例如 50e18）

    address public communityImplementation;
    address public roomImplementation;

    constructor(
        address unichatToken,
        address _treasury,
        uint256 _roomCreateFee,
        address _communityImpl,
        address _roomImpl
    ) Ownable(msg.sender) {
        require(unichatToken != address(0) && _treasury != address(0), "ZeroAddr");
        require(_communityImpl != address(0) && _roomImpl != address(0), "ImplNotSet");
        UNICHAT = IERC20(unichatToken);
        treasury = _treasury;
        roomCreateFee = _roomCreateFee;
        communityImplementation = _communityImpl;
        roomImplementation = _roomImpl;
    }

    function setImplementations(address _communityImpl, address _roomImpl) external onlyOwner {
        require(_communityImpl != address(0) && _roomImpl != address(0), "ZeroAddr");
        communityImplementation = _communityImpl;
        roomImplementation = _roomImpl;
        emit ImplementationsUpdated(_communityImpl, _roomImpl);
    }

    function setRoomCreateFee(uint256 newFee) external onlyOwner {
        roomCreateFee = newFee;
        emit RoomCreateFeeUpdated(newFee);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "ZeroAddr");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice 仅系统管理员可创建大群，并指定大群群主
    function createCommunity(address communityOwner) external onlyOwner returns (address community) {
        require(communityImplementation != address(0) && roomImplementation != address(0), "ImplNotSet");
        community = Clones.clone(communityImplementation);
        ICommunity(community).initialize(
            communityOwner,
            address(UNICHAT),
            treasury,
            roomCreateFee,
            roomImplementation
        );
        emit CommunityCreated(community, communityOwner);
    }
}
