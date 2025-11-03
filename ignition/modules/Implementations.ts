import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * 部署 Community 和 Room 实现合约（用于克隆）
 */
export default buildModule("ImplementationsModule", (m) => {
  // 部署 Community 实现合约
  const communityImpl = m.contract("Community");

  // 部署 Room 实现合约
  const roomImpl = m.contract("Room");

  return { communityImpl, roomImpl };
});

