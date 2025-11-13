import { network } from "hardhat";
import { writeFile, mkdir } from "fs/promises";
import type { Address } from "viem";

/**
 * 第一步：创建 9 个 Community 群聊
 * 
 * 功能：
 * 1. 使用已部署的 CommunityFactory 创建 9 个群聊（3个代币 × 3个档位）
 * 2. 保存创建的群聊地址到 JSON 文件
 * 
 * 使用方法：
 * pnpm run create-communities
 */

// 配置常量
const COMMUNITY_OWNER = "0xbdd3203FeD7bC268DC76BFF731E78C73f76053C1" as Address;

const TOKENS = {
  ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548" as Address,
  USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address,
  WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address,
};

const AVATARS = {
  ARB: "https://arbiscan.io/token/images/arbitrumone2_32_new.png",
  USDT: "https://arbiscan.io/token/images/usdt0_64.png",
  WETH: "https://arbiscan.io/token/images/weth_28.png",
};

const TIER_NAMES: Record<number, string> = {
  1: "比特鱼苗",
  2: "以太飞鱼",
  3: "POW 小鲸",
};

// 已部署的合约地址（从环境变量读取）
const FACTORY_ADDRESS = (process.env.FACTORY_ADDRESS || "") as Address;

// 数据结构
interface CommunityInfo {
  symbol: string;
  tier: number;
  name: string;
  address: Address;
  tokenAddress: Address;
  txHash: string;
  blockNumber: bigint;
}

async function main() {
  console.log("=".repeat(60));
  console.log("第一步：创建 9 个 Community 群聊");
  console.log("=".repeat(60));

  if (!FACTORY_ADDRESS) {
    throw new Error("请设置环境变量 FACTORY_ADDRESS");
  }

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  console.log(`\n使用账户: ${deployer.account.address}`);
  console.log(`群主账户: ${COMMUNITY_OWNER}`);
  console.log(`Factory 地址: ${FACTORY_ADDRESS}\n`);

  // 获取 Factory 合约实例
  const factory = await viem.getContractAt("CommunityFactory", FACTORY_ADDRESS);

  // 存储创建的群聊信息
  const communities: CommunityInfo[] = [];
  let counter = 0;

  // 创建所有群聊
  console.log("正在创建群聊...\n");

  for (const [symbol, tokenAddress] of Object.entries(TOKENS)) {
    for (const tier of [1, 2, 3]) {
      counter++;
      const name = `${symbol} ${TIER_NAMES[tier]}`;
      const avatarCid = AVATARS[symbol as keyof typeof AVATARS];

      console.log(`  [${counter}/9] ${name} (档位${tier})`);
      console.log(`    Token: ${tokenAddress}`);
      console.log(`    Owner: ${COMMUNITY_OWNER}`);

      try {
        // 调用 createCommunity
        const tx = await factory.write.createCommunity([
          COMMUNITY_OWNER,
          tokenAddress,
          tier,
          name,
          avatarCid,
        ]);

        console.log(`    Tx: ${tx}`);

        // 等待交易确认
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

        // 从事件中获取 Community 地址
        const logs = await publicClient.getContractEvents({
          address: factory.address,
          abi: factory.abi,
          eventName: "CommunityCreated",
          fromBlock: receipt.blockNumber,
          toBlock: receipt.blockNumber,
        });

        if (logs.length === 0) {
          throw new Error("未找到 CommunityCreated 事件");
        }

        const communityAddress = logs[0].args.community as Address;

        console.log(`    Community: ${communityAddress}`);
        console.log(`    ✓ 创建成功\n`);

        communities.push({
          symbol,
          tier,
          name,
          address: communityAddress,
          tokenAddress,
          txHash: tx,
          blockNumber: receipt.blockNumber,
        });

        // 等待一小段时间避免请求过快
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`    ✗ 创建失败: ${error}\n`);
        throw error;
      }
    }
  }

  // 保存结果
  console.log("保存结果...\n");

  const result = {
    timestamp: new Date().toISOString(),
    network: "arbitrum",
    factory: FACTORY_ADDRESS,
    owner: COMMUNITY_OWNER,
    communities: communities.map((c) => ({
      symbol: c.symbol,
      tier: c.tier,
      name: c.name,
      address: c.address,
      tokenAddress: c.tokenAddress,
      txHash: c.txHash,
      blockNumber: c.blockNumber.toString(),
    })),
    // 简化的地址映射（便于后续脚本使用）
    addressMap: {
      ARB: {} as Record<string, string>,
      USDT: {} as Record<string, string>,
      WETH: {} as Record<string, string>,
    },
  };

  // 填充地址映射
  for (const community of communities) {
    result.addressMap[community.symbol as keyof typeof result.addressMap][community.tier.toString()] = community.address;
  }

  const outputDir = "./output/arbitrum";
  const outputPath = `${outputDir}/created-communities.json`;

  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, JSON.stringify(result, null, 2), "utf-8");
    console.log(`  ✓ 已保存到 ${outputPath}\n`);
  } catch (error) {
    console.error(`  ✗ 保存失败: ${error}\n`);
    throw error;
  }

  // 打印汇总
  console.log("=".repeat(60));
  console.log("✅ 所有群聊创建完成！");
  console.log("=".repeat(60));

  console.log("\n📋 群聊地址汇总:\n");
  for (const community of communities) {
    console.log(`  ${community.name.padEnd(20)} ${community.address}`);
  }

  console.log(`\n💾 详细信息已保存到: ${outputPath}`);
  console.log(`\n⏭️  下一步流程:`);
  console.log(`\n   步骤 1: 手动更新 CSV 文件中的 community 地址`);
  console.log(`   将上面的群聊地址复制到对应的 data/arbitrum/{Symbol}/{Tier}.csv 文件`);
  console.log(`\n   步骤 2: 生成 Merkle Proof`);
  console.log(`   .\\scripts\\generate-all-proofs.ps1`);
  console.log(`\n   步骤 3: 设置 Merkle Root`);
  console.log(`   pnpm run set-merkle-roots`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ 执行失败:", error);
    process.exit(1);
  });

