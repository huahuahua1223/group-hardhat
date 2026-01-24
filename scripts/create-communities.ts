import { network } from "hardhat";
import { writeFile, mkdir, readFile } from "fs/promises";
import type { Address } from "viem";
import { getChainConfig } from "./config/chain-config.js";

/**
 * 第一步：创建 Community 群聊
 * 
 * 功能：
 * 1. 使用已部署的 CommunityFactory 创建群聊（根据链配置中的代币 × 3个档位）
 * 2. 保存创建的群聊地址到 JSON 文件
 * 3. 支持断点续传：如果中途失败，重新运行会跳过已创建的群聊
 * 4. 支持多链：通过 --network 参数指定链，自动适配配置
 * 
 * 使用方法：
 * pnpm hardhat run scripts/create-communities.ts --network arbitrum
 * pnpm hardhat run scripts/create-communities.ts --network opbnb
 */

// 配置常量
const COMMUNITY_OWNER = "0x0041d9424581231161D75AF27b8AB92090d3725e" as Address;

const TIER_NAMES: Record<number, string> = {
  1: "比特鱼苗",
  2: "以太飞鱼",
  3: "POW 小鲸",
};

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
  chainId: number;
  factory: Address;
  owner: Address;
  communities: CommunityInfo[];
  addressMap: Record<string, Record<string, string>>;
}

// 生成群聊的唯一键
function getCommunityKey(symbol: string, tier: number): string {
  return `${symbol}-${tier}`;
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
  console.log("第一步：创建 Community 群聊");
  console.log("=".repeat(60));

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  // 动态识别链
  const chainId = await publicClient.getChainId();
  const cfg = getChainConfig(chainId);

  console.log(`\n链信息:`);
  console.log(`  ChainId: ${chainId}`);
  console.log(`  网络: ${cfg.name}`);
  console.log(`  代币数: ${Object.keys(cfg.tokens).length}`);

  // 按链读取环境变量
  const FACTORY_ADDRESS = (process.env[cfg.factoryEnvKey] || "") as Address;
  const RED_PACKET_ADDRESS = (process.env[cfg.redPacketEnvKey] || "") as Address;

  if (!FACTORY_ADDRESS) {
    throw new Error(`请设置环境变量 ${cfg.factoryEnvKey}`);
  }
  if (!RED_PACKET_ADDRESS) {
    throw new Error(`请设置环境变量 ${cfg.redPacketEnvKey}`);
  }

  // 动态输出路径
  const OUTPUT_DIR = cfg.outputDir;
  const OUTPUT_PATH = `${OUTPUT_DIR}/created-communities.json`;

  // 使用配置中的 tokens 和 avatars
  const TOKENS = cfg.tokens;
  const AVATARS = cfg.avatars;

  console.log(`\n使用账户: ${deployer.account.address}`);
  console.log(`群主账户: ${COMMUNITY_OWNER}`);
  console.log(`Factory 地址: ${FACTORY_ADDRESS}`);
  console.log(`RedPacket 地址: ${RED_PACKET_ADDRESS}\n`);

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
      network: cfg.name,
      chainId,
      factory: FACTORY_ADDRESS,
      owner: COMMUNITY_OWNER,
      communities: communities,
      addressMap: {},
    };

    // 动态构建 addressMap
    for (const [symbol] of Object.entries(cfg.tokens)) {
      result.addressMap[symbol] = {};
    }
    for (const c of communities) {
      if (!result.addressMap[c.symbol]) {
        result.addressMap[c.symbol] = {};
      }
      result.addressMap[c.symbol][String(c.tier)] = c.address;
    }

    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2), "utf-8");
  }

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
      const avatarCid = AVATARS[symbol as keyof typeof AVATARS] ?? "";
      if (!avatarCid) {
        throw new Error(`未找到 ${symbol} 对应的头像 CID`);
      }
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
  console.log(`   将上面的群聊地址复制到对应的 data/${cfg.name}/{Symbol}/{Tier}.csv 文件`);
  console.log(`\n   步骤 2: 生成 Merkle Proof`);
  console.log(`   .\\scripts\\generate-all-proofs.ps1 -Chain ${cfg.name}`);
  console.log(`\n   步骤 3: 设置 Merkle Root`);
  console.log(`   pnpm hardhat run scripts/set-merkle-roots.ts --network ${cfg.name}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ 执行失败:", error);
    process.exit(1);
  });
