import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import MockTokenModule from "./MockToken.js";
import ImplementationsModule from "./Implementations.js";

/**
 * 部署 CommunityFactory 合约
 * 依赖：MockUNICHAT 代币、Community 和 Room 实现合约
 */
export default buildModule("CommunityFactoryModule", (m) => {
  // 获取依赖
  const { unichat } = m.useModule(MockTokenModule);
  const { communityImpl, roomImpl } = m.useModule(ImplementationsModule);

  // 部署参数
  const treasury = m.getAccount(0); // 使用第一个账户作为金库
  const roomCreateFee = m.getParameter("roomCreateFee", 50n * 10n**18n); // 50 UNICHAT

  // 部署 CommunityFactory
  const factory = m.contract("CommunityFactory", [
    unichat,
    treasury,
    roomCreateFee,
    communityImpl,
    roomImpl,
  ]);

  return { factory, unichat, communityImpl, roomImpl };
});

