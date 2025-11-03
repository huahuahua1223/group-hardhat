// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title MockUNICHAT
 * @notice 用于测试的 UNICHAT 代币，支持 EIP-2612 Permit
 */
contract MockUNICHAT is ERC20, ERC20Permit {
    constructor() ERC20("UNICHAT Token", "UNICHAT") ERC20Permit("UNICHAT Token") {
        // 铸造 1000万 UNICHAT 给部署者用于测试
        _mint(msg.sender, 10_000_000 * 10**18);
    }

    /// @notice 任何人都可以铸造（仅用于测试）
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

