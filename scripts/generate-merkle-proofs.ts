import { createReadStream } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { parse } from "csv-parse";
import { MerkleTree, computeLeaf, type MerkleLeaf } from "./utils/merkleTree.js";
import type { Address } from "viem";

/**
 * 从 CSV 文件生成 Merkle Tree 和 Proof
 * 
 * CSV 格式：
 * community,epoch,account,maxTier,validUntil,nonce
 * 0x1234...,1,0xabcd...,3,1735689600,0x0001...
 * 
 * 使用方法：
 * npx hardhat run scripts/generate-merkle-proofs.ts
 * 
 * 或指定 CSV 文件路径：
 * CSV_PATH=./data/whitelist.csv npx hardhat run scripts/generate-merkle-proofs.ts
 */

interface CSVRow {
  community: string;
  epoch: string;
  account: string;
  maxTier: string;
  validUntil: string;
  nonce: string;
}

interface ProofData {
  account: Address;
  maxTier: bigint;
  validUntil: bigint;
  nonce: `0x${string}`;
  proof: `0x${string}`[];
  leafHash: `0x${string}`;
}

interface OutputData {
  merkleRoot: `0x${string}`;
  community: Address;
  epoch: bigint;
  totalUsers: number;
  treeDepth: number;
  generatedAt: string;
  proofs: ProofData[];
}

async function main() {
  console.log("=".repeat(60));
  console.log("📋 从 CSV 生成 Merkle Tree 和 Proof");
  console.log("=".repeat(60));

  // 1. 读取 CSV 文件路径
  const csvPath = process.env.CSV_PATH || "./data/whitelist.csv";
  console.log(`\n📂 读取 CSV 文件: ${csvPath}\n`);

  // 提取代币符号和档位（从路径）
  // 例如: ./data/arbitrum/ARB/1.csv -> Symbol=ARB, maxTier=1
  const pathParts = csvPath.split('/');
  const symbol = pathParts[pathParts.length - 2] || 'UNKNOWN';  // ARB
  const maxTier = pathParts[pathParts.length - 1].replace('.csv', '') || 'UNKNOWN';  // 1

  console.log(`📊 代币符号: ${symbol}`);
  console.log(`🎯 档位: ${maxTier}\n`);

  // 2. 解析 CSV 文件
  const whitelist: MerkleLeaf[] = [];
  const expectedTier = BigInt(maxTier);
  
  try {
    await new Promise<void>((resolve, reject) => {
      createReadStream(csvPath)
        .pipe(parse({
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }))
        .on("data", (row: CSVRow) => {
          try {
            // 验证和解析数据
            const leaf: MerkleLeaf = {
              community: row.community as Address,
              epoch: BigInt(row.epoch),
              account: row.account.toLowerCase() as Address,  // 转小写
              maxTier: BigInt(row.maxTier),
              validUntil: BigInt(row.validUntil),
              nonce: row.nonce as `0x${string}`,
            };

            // 基本验证
            if (!leaf.community.startsWith("0x") || leaf.community.length !== 42) {
              throw new Error(`无效的 community 地址: ${row.community}`);
            }
            if (!leaf.account.startsWith("0x") || leaf.account.length !== 42) {
              throw new Error(`无效的 account 地址: ${row.account}`);
            }
            if (!leaf.nonce.startsWith("0x") || leaf.nonce.length !== 66) {
              throw new Error(`无效的 nonce: ${row.nonce}`);
            }

            // 验证档位一致性
            if (leaf.maxTier !== expectedTier) {
              console.warn(`⚠️  用户 ${leaf.account} 的档位 ${leaf.maxTier} 与文件档位 ${maxTier} 不一致`);
            }

            whitelist.push(leaf);
          } catch (error) {
            console.error(`❌ 解析行失败:`, row, error);
            throw error;
          }
        })
        .on("end", () => {
          console.log(`✅ 成功读取 ${whitelist.length} 条白名单记录\n`);
          resolve();
        })
        .on("error", reject);
    });
  } catch (error) {
    console.error("❌ 读取 CSV 文件失败:", error);
    console.log("\n💡 提示:");
    console.log(`   请确保 CSV 文件存在: ${csvPath}`);
    console.log("   或设置环境变量: CSV_PATH=./your/path.csv");
    console.log("\n   CSV 格式示例:");
    console.log("   community,epoch,account,maxTier,validUntil,nonce");
    console.log("   0x1234...,1,0xabcd...,3,1735689600,0x0001...");
    process.exit(1);
  }

  if (whitelist.length === 0) {
    console.error("❌ CSV 文件为空或没有有效数据");
    process.exit(1);
  }

  // 3. 打印白名单摘要
  console.log("📊 白名单摘要:");
  console.log(`   总用户数: ${whitelist.length}`);
  console.log(`   Community: ${whitelist[0].community}`);
  console.log(`   Epoch: ${whitelist[0].epoch}`);
  
  // 统计档位分布
  const tierCount = new Map<bigint, number>();
  whitelist.forEach(leaf => {
    tierCount.set(leaf.maxTier, (tierCount.get(leaf.maxTier) || 0) + 1);
  });
  console.log(`   档位分布:`);
  Array.from(tierCount.entries()).sort((a, b) => Number(b[0] - a[0])).forEach(([tier, count]) => {
    console.log(`     档位 ${tier}: ${count} 人`);
  });

  // 打印前几个用户
  console.log(`\n   前 5 个用户:`);
  whitelist.slice(0, 5).forEach((leaf, i) => {
    console.log(`     ${i + 1}. ${leaf.account} (档位: ${leaf.maxTier})`);
  });
  if (whitelist.length > 5) {
    console.log(`     ... 还有 ${whitelist.length - 5} 个用户`);
  }

  // 4. 构建 Merkle Tree
  console.log("\n🌳 构建 Merkle Tree...\n");
  
  const leaves = whitelist.map(computeLeaf);
  const tree = new MerkleTree(leaves);
  const root = tree.getRoot();
  const depth = tree.getDepth();

  console.log(`✅ Merkle Root: ${root}`);
  console.log(`✅ 树的深度: ${depth}`);
  console.log(`✅ 叶子节点: ${leaves.length}`);

  // 5. 生成所有用户的 Proof
  console.log("\n🔐 生成 Merkle Proof...\n");

  const proofs: ProofData[] = [];
  
  for (let i = 0; i < whitelist.length; i++) {
    const leaf = whitelist[i];
    const leafHash = computeLeaf(leaf);
    const proof = tree.getProof(leafHash);
    
    // 验证 Proof
    const isValid = tree.verify(leafHash, proof, root);
    if (!isValid) {
      console.error(`❌ 用户 ${leaf.account} 的 Proof 验证失败!`);
      process.exit(1);
    }

    proofs.push({
      account: leaf.account,
      maxTier: leaf.maxTier,
      validUntil: leaf.validUntil,
      nonce: leaf.nonce,
      proof,
      leafHash,
    });

    // 显示进度
    if ((i + 1) % 100 === 0 || i === whitelist.length - 1) {
      console.log(`   进度: ${i + 1}/${whitelist.length} (${Math.round((i + 1) / whitelist.length * 100)}%)`);
    }
  }

  console.log(`\n✅ 成功生成 ${proofs.length} 个 Proof`);

  // 6. 准备输出数据
  const outputData: OutputData = {
    merkleRoot: root,
    community: whitelist[0].community,
    epoch: whitelist[0].epoch,
    totalUsers: whitelist.length,
    treeDepth: depth,
    generatedAt: new Date().toISOString(),
    proofs,
  };

  // 7. 保存到文件
  console.log("\n💾 保存结果...\n");

  // 输出目录结构
  const chain = pathParts.includes('arbitrum') ? 'arbitrum' : 
                pathParts.includes('ethereum') ? 'ethereum' : 'unknown';

  const metadataDir = `./output/${chain}/metadata/${symbol}`;
  const proofMapDir = `./output/${chain}/proof-map/${symbol}`;

  // 文件路径（使用档位作为文件名）
  const metadataPath = `${metadataDir}/${maxTier}.json`;
  const proofMapPath = `${proofMapDir}/${maxTier}.csv`;

  try {
    // 确保输出目录存在
    await mkdir(metadataDir, { recursive: true });
    await mkdir(proofMapDir, { recursive: true });

    // 保存精简的元数据
    await writeFile(
      metadataPath,
      JSON.stringify({
        merkleRoot: root,
        totalUsers: whitelist.length,
        treeDepth: depth,
        generatedAt: new Date().toISOString(),
      }, null, 2),
      "utf-8"
    );
    console.log(`✅ 元数据已保存: ${metadataPath}`);

    // CSV 转义函数
    function escapeCSV(value: string): string {
      if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }

    // 生成 CSV 格式的 Proof Map
    const csvRows: string[] = [];
    csvRows.push("account,community,epoch,maxTier,validUntil,nonce,proof,leafHash");

    proofs.forEach((p, index) => {
      const leaf = whitelist[index];
      const row = [
        p.account.toLowerCase(),              // 小写地址
        leaf.community,                        // 群聊地址
        leaf.epoch.toString(),                 // epoch
        p.maxTier.toString(),                  // 档位
        p.validUntil.toString(),               // 有效期
        p.nonce,                               // nonce
        escapeCSV(JSON.stringify(p.proof)),    // proof 数组
        p.leafHash,                            // 叶子哈希
      ].join(",");
      csvRows.push(row);
    });

    await writeFile(proofMapPath, csvRows.join("\n"), "utf-8");
    console.log(`✅ Proof CSV 已保存: ${proofMapPath}`);

  } catch (error) {
    console.error("❌ 保存文件失败:", error);
    process.exit(1);
  }

  // 8. 打印使用说明
  console.log("\n" + "=".repeat(60));
  console.log(`✅ ${symbol} 的 Merkle Tree 和 Proof 生成完成！`);
  console.log("=".repeat(60));

  console.log("\n📁 输出文件:\n");
  console.log(`   元数据: ${metadataPath}`);
  console.log(`   Proof:  ${proofMapPath}`);

  console.log("\n📋 后续步骤:\n");
  console.log("1️⃣  在链上设置 Merkle Root:");
  console.log(`   Merkle Root: ${root}`);
  console.log(`   await community.write.setMerkleRoot([`);
  console.log(`     "${root}",`);
  console.log(`     "ipfs://Qm.../${symbol}.json"`);
  console.log(`   ]);`);

  console.log("\n2️⃣  导入 CSV 到 PostgreSQL:");
  console.log(`   \\COPY proof_map FROM '${proofMapPath}' CSV HEADER;`);

  console.log("\n3️⃣  PostgreSQL 表结构:");
  console.log(`   CREATE TABLE proof_map (`);
  console.log(`     account VARCHAR(42) PRIMARY KEY,`);
  console.log(`     community VARCHAR(42) NOT NULL,`);
  console.log(`     epoch BIGINT NOT NULL,`);
  console.log(`     max_tier INTEGER NOT NULL,`);
  console.log(`     valid_until BIGINT NOT NULL,`);
  console.log(`     nonce VARCHAR(66) NOT NULL,`);
  console.log(`     proof JSONB NOT NULL,`);
  console.log(`     leaf_hash VARCHAR(66),`);
  console.log(`     INDEX idx_community_epoch (community, epoch),`);
  console.log(`     INDEX idx_account (LOWER(account))`);
  console.log(`   );`);

  console.log("\n4️⃣  批量处理多个代币:");
  console.log(`   for symbol in ARB WETH USDT; do`);
  console.log(`     CSV_PATH=./data/${chain}/$symbol.csv pnpm hardhat run scripts/generate-merkle-proofs.ts`);
  console.log(`   done`);

  console.log("\n💡 提示:");
  console.log("   • 文件按代币符号命名，便于管理");
  console.log("   • CSV 格式可直接导入 PostgreSQL");
  console.log("   • Next.js 可通过 API 查询用户 Proof");
  console.log("   • 支持批量检查用户资格");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

