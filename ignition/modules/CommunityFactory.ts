import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import ImplementationsModule from "./Implementations.js";

/**
 * 部署 CommunityFactory 合约
 * 依赖：UNICHAT 代币、Community 和 Room 实现合约
 * 
 * 环境变量：
 * - UNICHAT_TOKEN_ADDRESS: UNICHAT 代币地址（必填）
 * 
 * 注意：不再自动部署 MockUNICHAT，需要提前部署代币并在 .env 中配置地址
 */
export default buildModule("CommunityFactoryModule", (m) => {
  // 从环境变量获取 UNICHAT 代币地址（必填）
  const unichatTokenAddress = process.env.UNICHAT_TOKEN_ADDRESS;
  
  if (!unichatTokenAddress) {
    throw new Error(
      "UNICHAT_TOKEN_ADDRESS 未设置！请在 .env 文件中设置 UNICHAT 代币地址"
    );
  }

  // 引用已部署的 UNICHAT 代币
  const unichat = m.contractAt("MockUNICHAT", unichatTokenAddress);

  // 获取实现合约
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

