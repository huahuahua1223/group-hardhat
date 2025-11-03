// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title MockUNICHAT
 * @notice 用于测试的 UNICHAT 代币，支持 EIP-2612 Permit
 * @dev 继承自 ERC20 和 ERC20Permit，实现标准 ERC20 代币功能和 Permit 签名授权功能
 */
contract MockUNICHAT is ERC20, ERC20Permit {
    /**
     * @notice 构造函数，初始化代币名称和符号
     * @dev 部署时自动给部署者铸造 1000 万 UNICHAT 代币
     */
    constructor() ERC20("UNICHAT Token", "UNICHAT") ERC20Permit("UNICHAT Token") {
        // 铸造 1000万 UNICHAT 给部署者用于测试
        _mint(msg.sender, 10_000_000 * 10**18);
    }

    /**
     * @notice 铸造新代币（仅用于测试环境）
     * @dev 任何人都可以调用此函数铸造代币，生产环境应限制权限
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

