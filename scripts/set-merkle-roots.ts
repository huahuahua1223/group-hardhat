import { network } from "hardhat";
import { readFile, writeFile } from "fs/promises";
import type { Address } from "viem";

/**
 * 第二步：为所有 Community 设置 Merkle Root
 * 
 * 功能：
 * 1. 读取 created-communities.json 获取群聊地址
 * 2. 读取对应的 Merkle Root 元数据
 * 3. 为每个群聊设置 Merkle Root
 * 
 * 使用方法：
 * pnpm run set-merkle-roots
 */

// 数据结构
interface CommunityInfo {
  symbol: string;
  tier: number;
  name: string;
  address: Address;
  tokenAddress: Address;
  txHash: string;
  blockNumber: string;
}

interface CreatedCommunitiesData {
  timestamp: string;
  network: string;
  factory: Address;
  owner: Address;
  communities: CommunityInfo[];
  addressMap: Record<string, Record<string, string>>;
}

interface MerkleMetadata {
  merkleRoot: string;
  totalUsers: number;
  treeDepth: number;
  generatedAt: string;
}

interface MerkleRootResult {
  symbol: string;
  tier: number;
  name: string;
  address: Address;
  merkleRoot: string;
  metadataUri: string;
  txHash: string;
  totalUsers: number;
}

// 读取已创建的群聊信息
async function loadCreatedCommunities(): Promise<CreatedCommunitiesData> {
  const filePath = "./output/arbitrum/created-communities.json";
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`无法读取群聊信息: ${filePath}\n请先运行 create-communities.ts 创建群聊`);
  }
}

// 读取 Merkle Root
async function loadMerkleRoot(symbol: string, tier: number): Promise<MerkleMetadata> {
  const metadataPath = `./output/arbitrum/metadata/${symbol}/${tier}.json`;
  try {
    const content = await readFile(metadataPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`无法读取 Merkle Root: ${metadataPath}\n请先运行 generate-all-proofs.ps1 生成 Merkle Proof`);
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("第二步：为所有 Community 设置 Merkle Root");
  console.log("=".repeat(60));

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  console.log(`\n使用账户: ${deployer.account.address}\n`);

  // 1. 读取已创建的群聊信息
  console.log("1️⃣  读取群聊信息...\n");
  const data = await loadCreatedCommunities();
  console.log(`  ✓ 找到 ${data.communities.length} 个群聊`);
  console.log(`  创建时间: ${data.timestamp}`);
  console.log(`  网络: ${data.network}\n`);

  // 2. 为每个群聊设置 Merkle Root
  console.log("2️⃣  正在设置 Merkle Root...\n");

  const results: MerkleRootResult[] = [];
  let counter = 0;

  for (const community of data.communities) {
    counter++;
    console.log(`  [${counter}/${data.communities.length}] ${community.name}`);
    console.log(`    Community: ${community.address}`);

    try {
      // 读取 Merkle Root
      const metadata = await loadMerkleRoot(community.symbol, community.tier);
      console.log(`    Merkle Root: ${metadata.merkleRoot}`);
      console.log(`    用户数: ${metadata.totalUsers}`);

      // 获取 Community 合约实例
      const communityContract = await viem.getContractAt("Community", community.address as Address);
      
      // 构建 IPFS URI
      const metadataUri = `ipfs://community-metadata/${community.symbol}/${community.tier}.json`;

      // 设置 Merkle Root
      const tx = await communityContract.write.setMerkleRoot(
        [metadata.merkleRoot as `0x${string}`, metadataUri],
        { account: deployer.account }
      );

      console.log(`    Tx: ${tx}`);

      // 等待交易确认
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log(`    ✓ Merkle Root 已设置\n`);

      results.push({
        symbol: community.symbol,
        tier: community.tier,
        name: community.name,
        address: community.address as Address,
        merkleRoot: metadata.merkleRoot,
        metadataUri,
        txHash: tx,
        totalUsers: metadata.totalUsers,
      });

      // 等待一小段时间避免请求过快
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`    ✗ 设置失败: ${error}\n`);
      throw error;
    }
  }

  // 3. 保存结果
  console.log("3️⃣  保存结果...\n");

  const finalResult = {
    timestamp: new Date().toISOString(),
    network: data.network,
    setBy: deployer.account.address,
    results: results.map((r) => ({
      symbol: r.symbol,
      tier: r.tier,
      name: r.name,
      address: r.address,
      merkleRoot: r.merkleRoot,
      metadataUri: r.metadataUri,
      txHash: r.txHash,
      totalUsers: r.totalUsers,
    })),
    // 完整的群聊配置（包含创建和 Merkle Root 信息）
    addressMap: data.addressMap,
  };

  const outputPath = "./output/arbitrum/deployed-communities.json";

  try {
    await writeFile(outputPath, JSON.stringify(finalResult, null, 2), "utf-8");
    console.log(`  ✓ 已保存到 ${outputPath}\n`);
  } catch (error) {
    console.error(`  ✗ 保存失败: ${error}\n`);
  }

  // 4. 打印汇总
  console.log("=".repeat(60));
  console.log("✅ 所有 Merkle Root 设置完成！");
  console.log("=".repeat(60));

  console.log("\n📋 设置结果汇总:\n");
  for (const result of results) {
    console.log(`  ${result.name.padEnd(20)} ${result.totalUsers.toString().padStart(3)} 个用户`);
  }

  console.log(`\n💾 详细信息已保存到: ${outputPath}`);
  console.log(`\n✅ 初始化完成！群聊已准备就绪。`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ 执行失败:", error);
    process.exit(1);
  });

