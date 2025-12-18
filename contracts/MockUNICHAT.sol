// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title MockUNICHAT
 * @notice Mock UNICHAT token for testing, supports EIP-2612 Permit
 * @dev Inherits from ERC20 and ERC20Permit, implements standard ERC20 token functionality and Permit signature authorization
 */
contract MockUNICHAT is ERC20, ERC20Permit {
    /**
     * @notice Constructor, initializes token name and symbol
     * @dev Automatically mints 10 million UNICHAT tokens to deployer upon deployment
     */
    constructor() ERC20("UNICHAT Token", "UNICHAT") ERC20Permit("UNICHAT Token") {
        // Mint 10 million UNICHAT to deployer for testing
        _mint(msg.sender, 10_000_000 * 10**18);
    }

    /**
     * @notice Mint new tokens (only for testing environment)
     * @dev Anyone can call this function to mint tokens, production environment should restrict permissions
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

