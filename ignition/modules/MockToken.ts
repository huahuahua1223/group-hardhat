import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * 部署 MockUNICHAT 代币（用于测试）
 */
export default buildModule("MockTokenModule", (m) => {
  const unichat = m.contract("MockUNICHAT");

  return { unichat };
});

