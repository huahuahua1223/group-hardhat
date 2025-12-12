import { network } from "hardhat";
import { writeFile, mkdir, readFile } from "fs/promises";
import type { Address } from "viem";

/**
 * 第一步：创建 9 个 Community 群聊
 * 
 * 功能：
 * 1. 使用已部署的 CommunityFactory 创建 9 个群聊（3个代币 × 3个档位）
 * 2. 保存创建的群聊地址到 JSON 文件
 * 3. 支持断点续传：如果中途失败，重新运行会跳过已创建的群聊
 * 
 * 使用方法：
 * pnpm run create-communities
 */

// 配置常量
const COMMUNITY_OWNER = "0x930AB98c99E6AaAc76A6AeCFAd9da77A7b7C2Fa8" as Address;

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
const RED_PACKET_ADDRESS = (process.env.RED_PACKET_ADDRESS || "") as Address;

// 输出文件路径
const OUTPUT_DIR = "./output/arbitrum";
const OUTPUT_PATH = `${OUTPUT_DIR}/created-communities.json`;

// 数据结构
interface CommunityInfo {
  symbol: string;
  tier: number;
  name: string;
  address: Address;
  tokenAddress: Address;
  txHash: string;
  blockNumber: string;
  redPacketSet?: boolean;
}

interface SavedData {
  timestamp: string;
  network: string;
  factory: Address;
  owner: Address;
  communities: CommunityInfo[];
  addressMap: Record<string, Record<string, string>>;
}

// 生成群聊的唯一键
function getCommunityKey(symbol: string, tier: number): string {
  return `${symbol}-${tier}`;
}

// 加载已保存的数据
async function loadExistingData(): Promise<SavedData | null> {
  try {
    const content = await readFile(OUTPUT_PATH, "utf-8");
    return JSON.parse(content) as SavedData;
  } catch {
    return null;
  }
}

// 保存数据到文件
async function saveData(communities: CommunityInfo[]): Promise<void> {
  const result: SavedData = {
    timestamp: new Date().toISOString(),
    network: "arbitrum",
    factory: FACTORY_ADDRESS,
    owner: COMMUNITY_OWNER,
    communities: communities,
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

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2), "utf-8");
}

// 重试查询事件
async function getEventWithRetry(
  publicClient: any,
  factory: any,
  blockNumber: bigint,
  maxRetries: number = 5,
  delayMs: number = 3000
): Promise<Address | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // 扩大查询范围：当前区块 ± 2
    const fromBlock = blockNumber > 2n ? blockNumber - 2n : 0n;
    const toBlock = blockNumber + 2n;

    const logs = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "CommunityCreated",
      fromBlock,
      toBlock,
    });

    if (logs.length > 0) {
      // 返回最新的一个事件
      return logs[logs.length - 1].args.community as Address;
    }

    if (attempt < maxRetries) {
      console.log(`    ⏳ 未找到事件，${delayMs / 1000}秒后重试 (${attempt}/${maxRetries})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

async function main() {
  console.log("=".repeat(60));
  console.log("第一步：创建 9 个 Community 群聊");
  console.log("=".repeat(60));

  if (!FACTORY_ADDRESS) {
    throw new Error("请设置环境变量 FACTORY_ADDRESS");
  }
  if (!RED_PACKET_ADDRESS) {
    throw new Error("请设置环境变量 RED_PACKET_ADDRESS");
  }

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  console.log(`\n使用账户: ${deployer.account.address}`);
  console.log(`群主账户: ${COMMUNITY_OWNER}`);
  console.log(`Factory 地址: ${FACTORY_ADDRESS}`);
  console.log(`RedPacket 地址: ${RED_PACKET_ADDRESS}\n`);

  // 获取 Factory 合约实例
  const factory = await viem.getContractAt("CommunityFactory", FACTORY_ADDRESS);

  // 加载已存在的数据（断点续传）
  const existingData = await loadExistingData();
  const existingMap = new Map<string, CommunityInfo>();
  
  if (existingData && existingData.communities.length > 0) {
    console.log(`📂 发现已保存的数据，包含 ${existingData.communities.length} 个群聊\n`);
    for (const c of existingData.communities) {
      existingMap.set(getCommunityKey(c.symbol, c.tier), c);
    }
  }

  // 存储创建的群聊信息
  const communities: CommunityInfo[] = [...existingData?.communities || []];
  let counter = 0;
  let created = 0;
  let skipped = 0;

  // 创建所有群聊
  console.log("正在创建群聊...\n");

  for (const [symbol, tokenAddress] of Object.entries(TOKENS)) {
    for (const tier of [1, 2, 3]) {
      counter++;
      const name = `${symbol} ${TIER_NAMES[tier]}`;
      const avatarCid = AVATARS[symbol as keyof typeof AVATARS];
      const key = getCommunityKey(symbol, tier);

      console.log(`  [${counter}/9] ${name} (档位${tier})`);

      // 检查是否已创建
      const existing = existingMap.get(key);
      if (existing) {
        console.log(`    地址: ${existing.address}`);
        
        // 检查是否需要设置红包合约
        if (!existing.redPacketSet) {
          console.log(`    ⚠️  红包合约未设置，正在设置...`);
          try {
            const community = await viem.getContractAt("Community", existing.address);
            const setTx = await community.write.setRedPacket([RED_PACKET_ADDRESS]);
            await publicClient.waitForTransactionReceipt({ hash: setTx });
            console.log(`    SetRedPacket Tx: ${setTx}`);
            
            // 更新状态
            existing.redPacketSet = true;
            const idx = communities.findIndex(c => c.symbol === symbol && c.tier === tier);
            if (idx >= 0) {
              communities[idx] = existing;
            }
            await saveData(communities);
            console.log(`    ✓ 红包合约已设置\n`);
          } catch (error) {
            console.log(`    ⚠️  设置红包合约失败（可能已设置）: ${error}\n`);
          }
        } else {
          console.log(`    ⏭️  已创建，跳过\n`);
        }
        skipped++;
        continue;
      }

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

        // 使用重试机制获取事件
        const communityAddress = await getEventWithRetry(
          publicClient,
          factory,
          receipt.blockNumber
        );

        if (!communityAddress) {
          throw new Error("多次重试后仍未找到 CommunityCreated 事件");
        }

        console.log(`    Community: ${communityAddress}`);

        // 设置红包合约地址
        const community = await viem.getContractAt("Community", communityAddress);
        const setTx = await community.write.setRedPacket([RED_PACKET_ADDRESS]);
        await publicClient.waitForTransactionReceipt({ hash: setTx });
        console.log(`    SetRedPacket Tx: ${setTx}`);
        console.log(`    ✓ 创建成功\n`);

        const newCommunity: CommunityInfo = {
          symbol,
          tier,
          name,
          address: communityAddress,
          tokenAddress,
          txHash: tx,
          blockNumber: receipt.blockNumber.toString(),
          redPacketSet: true,
        };

        communities.push(newCommunity);
        created++;

        // 立即保存（增量保存，防止丢失进度）
        await saveData(communities);
        console.log(`    💾 进度已保存\n`);

        // 等待一小段时间避免请求过快
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`    ✗ 创建失败: ${error}\n`);
        
        // 保存当前进度后再抛出错误
        if (communities.length > 0) {
          await saveData(communities);
          console.log(`    💾 已保存当前进度 (${communities.length} 个群聊)\n`);
        }
        throw error;
      }
    }
  }

  // 打印汇总
  console.log("=".repeat(60));
  console.log("✅ 所有群聊创建完成！");
  console.log("=".repeat(60));

  console.log(`\n📊 汇总:`);
  console.log(`  新创建: ${created}`);
  console.log(`  已跳过: ${skipped}`);
  console.log(`  总计: ${communities.length}\n`);

  console.log("📋 群聊地址汇总:\n");
  for (const community of communities) {
    console.log(`  ${community.name.padEnd(20)} ${community.address}`);
  }

  console.log(`\n💾 详细信息已保存到: ${OUTPUT_PATH}`);
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
