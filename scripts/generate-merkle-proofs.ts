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

  // 2. 解析 CSV 文件
  const whitelist: MerkleLeaf[] = [];
  
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
              account: row.account as Address,
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

  const outputDir = "./output";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const outputPath = `${outputDir}/merkle-proofs-${timestamp}.json`;
  const metadataPath = `${outputDir}/merkle-metadata-${timestamp}.json`;
  const proofMapPath = `${outputDir}/proof-map-${timestamp}.json`;

  try {
    // 确保输出目录存在
    await mkdir(outputDir, { recursive: true });

    // 保存完整数据
    await writeFile(
      outputPath,
      JSON.stringify(outputData, (_, value) =>
        typeof value === "bigint" ? value.toString() : value
      , 2),
      "utf-8"
    );
    console.log(`✅ 完整数据已保存: ${outputPath}`);

    // 保存 Merkle Root 和元数据（用于链上设置）
    await writeFile(
      metadataPath,
      JSON.stringify({
        merkleRoot: root,
        community: whitelist[0].community,
        epoch: whitelist[0].epoch.toString(),
        totalUsers: whitelist.length,
        treeDepth: depth,
        generatedAt: outputData.generatedAt,
      }, null, 2),
      "utf-8"
    );
    console.log(`✅ 元数据已保存: ${metadataPath}`);

    // 创建按用户地址索引的 Proof 映射（方便查询）
    const proofMap: Record<string, any> = {};
    proofs.forEach(p => {
      proofMap[p.account.toLowerCase()] = {
        maxTier: p.maxTier.toString(),
        validUntil: p.validUntil.toString(),
        nonce: p.nonce,
        proof: p.proof,
        leafHash: p.leafHash,
      };
    });
    await writeFile(proofMapPath, JSON.stringify(proofMap, null, 2), "utf-8");
    console.log(`✅ Proof 映射已保存: ${proofMapPath}`);

  } catch (error) {
    console.error("❌ 保存文件失败:", error);
    process.exit(1);
  }

  // 8. 打印使用说明
  console.log("\n" + "=".repeat(60));
  console.log("✅ Merkle Tree 和 Proof 生成完成！");
  console.log("=".repeat(60));

  console.log("\n📋 后续步骤:\n");
  console.log("1️⃣  在链上设置 Merkle Root:");
  console.log(`   await community.write.setMerkleRoot([`);
  console.log(`     "${root}",`);
  console.log(`     "ipfs://QmYourMetadataHash"  // 上传元数据到 IPFS`);
  console.log(`   ]);`);

  console.log("\n2️⃣  用户加入大群（示例）:");
  const exampleUser = proofs[0];
  console.log(`   // 用户: ${exampleUser.account}`);
  console.log(`   await community.write.joinCommunity([`);
  console.log(`     ${exampleUser.maxTier}n,  // maxTier`);
  console.log(`     ${whitelist[0].epoch}n,   // epoch`);
  console.log(`     ${exampleUser.validUntil}n,  // validUntil`);
  console.log(`     "${exampleUser.nonce}",  // nonce`);
  console.log(`     [  // proof`);
  exampleUser.proof.slice(0, 2).forEach(p => console.log(`       "${p}",`));
  if (exampleUser.proof.length > 2) {
    console.log(`       // ... ${exampleUser.proof.length - 2} more`);
  }
  console.log(`     ]`);
  console.log(`   ]);`);

  console.log("\n3️⃣  查询特定用户的 Proof:");
  console.log(`   // 从 ${proofMapPath.split('/').pop()} 中查询`);
  console.log(`   const userAddress = "0x...".toLowerCase();`);
  console.log(`   const proofData = proofMap[userAddress];`);

  console.log("\n💡 提示:");
  console.log("   • 请妥善保管生成的 JSON 文件");
  console.log("   • 建议将元数据上传到 IPFS");
  console.log("   • 用户可通过 API 查询自己的 Proof");
  console.log("   • Merkle Root 需要群主在链上设置");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

