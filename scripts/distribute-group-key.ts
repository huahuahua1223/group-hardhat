/**
 * @title 群密钥分发脚本
 * @notice 演示如何使用密钥分发功能
 * @dev 完整流程：
 *      1. 获取活跃成员列表
 *      2. 为每个成员使用其公钥加密群密钥
 *      3. 构建 Merkle Tree
 *      4. 上传加密密钥文件到 IPFS
 *      5. 调用 distributeGroupKey 保存 Merkle Root 和 CID
 */

import { network } from "hardhat";
import { keccak256, encodePacked, encodeAbiParameters, type Address } from "viem";
import { MerkleTree } from "merkletreejs";

/**
 * 计算密钥分发的 Merkle Leaf
 * @param account 用户地址
 * @param encryptedKey 加密后的群密钥
 */
function computeKeyLeaf(account: Address, encryptedKey: string): Buffer {
  const leaf = keccak256(
    encodePacked(
      ["address", "bytes"],
      [account, encodeAbiParameters([{ type: "string" }], [encryptedKey])]
    )
  );
  return Buffer.from(leaf.slice(2), "hex");
}

/**
 * 模拟使用用户公钥加密群密钥
 * 实际应用中，应该使用真实的 RSA 加密
 */
function encryptGroupKeyForUser(userAddress: string, groupKey: string): string {
  // 这里仅作演示，实际应该使用用户的 RSA 公钥进行加密
  return `encrypted_${userAddress.slice(2, 10)}_${Buffer.from(groupKey).toString("base64").slice(0, 20)}`;
}

/**
 * 模拟上传到 IPFS
 * 实际应用中，应该使用真实的 IPFS 客户端
 */
async function uploadToIPFS(data: any): Promise<string> {
  // 这里仅作演示，实际应该调用 IPFS API
  console.log("📤 上传数据到 IPFS...");
  console.log("数据:", JSON.stringify(data, null, 2));
  
  // 模拟 IPFS CID
  const mockCid = `Qm${Buffer.from(JSON.stringify(data)).toString("hex").slice(0, 44)}`;
  console.log(`✅ 上传完成，CID: ${mockCid}`);
  
  return mockCid;
}

async function main() {
  const { viem } = await network.connect();
  const [deployer, communityOwner] = await viem.getWalletClients();

  // 获取 Community 合约地址（从命令行参数或环境变量）
  const communityAddress = process.env.COMMUNITY_ADDRESS as Address;
  if (!communityAddress) {
    throw new Error("请设置 COMMUNITY_ADDRESS 环境变量");
  }

  const community = await viem.getContractAt("Community", communityAddress);
  
  console.log("🔑 开始群密钥分发流程...");
  console.log("大群地址:", communityAddress);
  console.log("群主地址:", communityOwner.account.address);
  console.log("");

  // 步骤 1: 获取活跃成员列表
  console.log("📋 步骤 1: 获取活跃成员列表");
  const activeMembersCount = await community.read.getActiveMembersCount();
  console.log(`活跃成员总数: ${activeMembersCount}`);

  const batchSize = 100;
  const allActiveMembers: Address[] = [];
  
  for (let i = 0; i < Number(activeMembersCount); i += batchSize) {
    const members = await community.read.getActiveMembers([BigInt(i), BigInt(batchSize)]);
    allActiveMembers.push(...(members as Address[]));
  }
  
  console.log(`✅ 获取到 ${allActiveMembers.length} 个活跃成员`);
  console.log("前 5 个成员:", allActiveMembers.slice(0, 5));
  console.log("");

  // 步骤 2: 生成群密钥
  console.log("🔐 步骤 2: 生成群密钥");
  const groupKey = `group_key_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  console.log(`✅ 群密钥已生成: ${groupKey.slice(0, 20)}...`);
  console.log("");

  // 步骤 3: 为每个成员加密群密钥
  console.log("🔒 步骤 3: 为每个成员加密群密钥");
  const encryptedKeysData: Array<{
    address: string;
    encryptedKey: string;
    tier?: number;
  }> = [];

  for (const memberAddress of allActiveMembers) {
    // 获取成员档位信息（可选）
    const tier = await community.read.memberTier([memberAddress]);
    
    // 使用成员的公钥加密群密钥
    const encryptedKey = encryptGroupKeyForUser(memberAddress, groupKey);
    
    encryptedKeysData.push({
      address: memberAddress,
      encryptedKey: encryptedKey,
      tier: Number(tier),
    });
  }
  
  console.log(`✅ 为 ${encryptedKeysData.length} 个成员加密完成`);
  console.log("");

  // 步骤 4: 构建 Merkle Tree
  console.log("🌳 步骤 4: 构建 Merkle Tree");
  const leaves = encryptedKeysData.map(item => 
    computeKeyLeaf(item.address as Address, item.encryptedKey)
  );
  
  const merkleTree = new MerkleTree(leaves, keccak256, { 
    sortPairs: true,
    hashLeaves: false  // 叶子节点已经是哈希值
  });
  
  const merkleRoot = `0x${merkleTree.getRoot().toString("hex")}` as `0x${string}`;
  console.log(`✅ Merkle Root: ${merkleRoot}`);
  console.log(`   树深度: ${merkleTree.getDepth()}`);
  console.log(`   叶子节点数: ${merkleTree.getLeafCount()}`);
  console.log("");

  // 步骤 5: 准备上传到 IPFS 的数据
  console.log("📦 步骤 5: 准备 IPFS 数据");
  const ipfsData = {
    version: "1.0",
    distributionTime: new Date().toISOString(),
    communityAddress: communityAddress,
    merkleRoot: merkleRoot,
    totalMembers: encryptedKeysData.length,
    encryptedKeys: encryptedKeysData,
    // 为前端提供验证用的 Merkle Proof
    merkleProofs: encryptedKeysData.reduce((acc, item) => {
      const leaf = computeKeyLeaf(item.address as Address, item.encryptedKey);
      const proof = merkleTree.getHexProof(leaf);
      acc[item.address] = proof;
      return acc;
    }, {} as Record<string, string[]>),
  };
  
  console.log(`✅ 数据准备完成，大小: ${JSON.stringify(ipfsData).length} 字节`);
  console.log("");

  // 步骤 6: 上传到 IPFS
  console.log("☁️  步骤 6: 上传到 IPFS");
  const ipfsCid = await uploadToIPFS(ipfsData);
  console.log("");

  // 步骤 7: 调用合约保存 Merkle Root 和 CID
  console.log("⛓️  步骤 7: 上链保存分发信息");
  const tx = await community.write.distributeGroupKey(
    [merkleRoot, ipfsCid],
    { account: communityOwner.account }
  );
  
  console.log(`📝 交易已提交: ${tx}`);
  
  const publicClient = await viem.getPublicClient();
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  
  console.log(`✅ 交易已确认，区块号: ${receipt.blockNumber}`);
  console.log("");

  // 步骤 8: 验证分发信息
  console.log("🔍 步骤 8: 验证分发信息");
  const latestDistribution = await community.read.getLatestKeyDistribution();
  const distributionEpoch = await community.read.currentDistributionEpoch();
  
  console.log(`分发版本: ${distributionEpoch}`);
  console.log(`Merkle Root: ${latestDistribution[0]}`);
  console.log(`IPFS CID: ${latestDistribution[1]}`);
  console.log(`时间戳: ${new Date(Number(latestDistribution[3]) * 1000).toISOString()}`);
  console.log("");

  // 步骤 9: 验证几个成员的密钥
  console.log("✓ 步骤 9: 验证成员密钥");
  const testMembers = encryptedKeysData.slice(0, Math.min(3, encryptedKeysData.length));
  
  for (const item of testMembers) {
    const leaf = computeKeyLeaf(item.address as Address, item.encryptedKey);
    const proof = merkleTree.getHexProof(leaf) as `0x${string}`[];
    
    const isValid = await community.read.verifyEncryptedKey([
      distributionEpoch,
      item.address as Address,
      encodeAbiParameters([{ type: "string" }], [item.encryptedKey]),
      proof,
    ]);
    
    console.log(`  ${item.address}: ${isValid ? "✅ 验证通过" : "❌ 验证失败"}`);
  }
  console.log("");

  // 输出摘要
  console.log("=" .repeat(60));
  console.log("🎉 密钥分发完成！");
  console.log("=" .repeat(60));
  console.log(`📊 分发摘要:`);
  console.log(`   - 分发版本: ${distributionEpoch}`);
  console.log(`   - 成员数量: ${encryptedKeysData.length}`);
  console.log(`   - IPFS CID: ${ipfsCid}`);
  console.log(`   - Merkle Root: ${merkleRoot}`);
  console.log(`   - 交易哈希: ${tx}`);
  console.log("");
  console.log("📱 前端使用说明:");
  console.log(`   1. 从 IPFS 下载文件: https://ipfs.io/ipfs/${ipfsCid}`);
  console.log(`   2. 根据用户地址找到对应的 encryptedKey`);
  console.log(`   3. 使用用户私钥解密 encryptedKey 得到群密钥`);
  console.log(`   4. 使用 merkleProofs[userAddress] 验证密钥有效性`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ 错误:", error);
    process.exit(1);
  });

