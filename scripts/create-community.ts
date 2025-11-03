import { network } from "hardhat";
import { parseEther, type Address } from "viem";
import { MerkleTree, computeLeaf, type MerkleLeaf } from "./utils/merkleTree.js";

/**
 * 脚本：创建大群并设置 Merkle Root
 * 
 * 使用方法：
 * npx hardhat run scripts/create-community.ts
 */

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, communityOwner, user1, user2, user3] = await viem.getWalletClients();

  console.log("=".repeat(60));
  console.log("创建大群并设置 Merkle Root");
  console.log("=".repeat(60));

  // 1. 部署合约（假设已部署，这里获取地址）
  console.log("\n1️⃣  部署 MockUNICHAT 代币...");
  const unichat = await viem.deployContract("MockUNICHAT");
  console.log(`   ✅ UNICHAT 代币地址: ${unichat.address}`);

  console.log("\n2️⃣  部署实现合约...");
  const communityImpl = await viem.deployContract("Community");
  const roomImpl = await viem.deployContract("Room");
  console.log(`   ✅ Community 实现: ${communityImpl.address}`);
  console.log(`   ✅ Room 实现: ${roomImpl.address}`);

  console.log("\n3️⃣  部署 CommunityFactory...");
  const factory = await viem.deployContract("CommunityFactory", [
    unichat.address,
    deployer.account.address, // treasury
    parseEther("50"), // roomCreateFee
    communityImpl.address,
    roomImpl.address,
  ]);
  console.log(`   ✅ Factory 地址: ${factory.address}`);

  // 2. 创建大群
  console.log("\n4️⃣  创建大群...");
  const createTx = await factory.write.createCommunity([communityOwner.account.address]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createTx });
  
  // 从事件中获取 community 地址
  const logs = await publicClient.getContractEvents({
    address: factory.address,
    abi: factory.abi,
    eventName: "CommunityCreated",
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  
  const communityAddress = logs[0].args.community as Address;
  console.log(`   ✅ 大群地址: ${communityAddress}`);

  // 获取 Community 合约实例
  const community = await viem.getContractAt("Community", communityAddress);

  // 3. 生成 Merkle Tree（模拟链下计算）
  console.log("\n5️⃣  生成 Merkle Tree...");
  
  const epoch = 1n;
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30); // 30天后过期
  const nonce = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;

  // 创建白名单（3个用户，不同档位）
  const whitelist: MerkleLeaf[] = [
    {
      community: communityAddress,
      epoch,
      account: user1.account.address,
      maxTier: 3n, // VIP 档位
      validUntil,
      nonce,
    },
    {
      community: communityAddress,
      epoch,
      account: user2.account.address,
      maxTier: 2n, // 高级档位
      validUntil,
      nonce,
    },
    {
      community: communityAddress,
      epoch,
      account: user3.account.address,
      maxTier: 1n, // 普通档位
      validUntil,
      nonce,
    },
  ];

  const leaves = whitelist.map(computeLeaf);
  const tree = new MerkleTree(leaves);
  const root = tree.getRoot();

  console.log(`   ✅ Merkle Root: ${root}`);
  console.log(`   ✅ 白名单用户数: ${whitelist.length}`);

  // 4. 设置 Merkle Root（使用 communityOwner）
  console.log("\n6️⃣  设置 Merkle Root...");
  const setRootTx = await community.write.setMerkleRoot(
    [root, "ipfs://QmExample123"],
    { account: communityOwner.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: setRootTx });
  console.log(`   ✅ Merkle Root 已设置`);

  // 5. 验证用户资格（链下验证）
  console.log("\n7️⃣  验证用户资格（链下）...");
  for (const leaf of whitelist) {
    const leafHash = computeLeaf(leaf);
    const proof = tree.getProof(leafHash);
    const isValid = tree.verify(leafHash, proof, root);
    console.log(`   ${isValid ? "✅" : "❌"} ${leaf.account} (档位 ${leaf.maxTier}): ${isValid ? "有效" : "无效"}`);
  }

  // 6. 链上验证资格
  console.log("\n8️⃣  验证用户资格（链上）...");
  for (const leaf of whitelist) {
    const leafHash = computeLeaf(leaf);
    const proof = tree.getProof(leafHash);
    const eligible = await community.read.eligible([
      leaf.account,
      leaf.maxTier,
      leaf.epoch,
      leaf.validUntil,
      leaf.nonce,
      proof,
    ]);
    console.log(`   ${eligible ? "✅" : "❌"} ${leaf.account}: ${eligible ? "有资格" : "无资格"}`);
  }

  // 7. 用户加入大群
  console.log("\n9️⃣  用户加入大群...");
  for (let i = 0; i < whitelist.length; i++) {
    const leaf = whitelist[i];
    const leafHash = computeLeaf(leaf);
    const proof = tree.getProof(leafHash);
    const userClient = [user1, user2, user3][i];

    const joinTx = await community.write.joinCommunity(
      [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, proof],
      { account: userClient.account }
    );
    await publicClient.waitForTransactionReceipt({ hash: joinTx });
    
    const isActive = await community.read.isActiveMember([leaf.account]);
    console.log(`   ${isActive ? "✅" : "❌"} ${leaf.account} 已加入 (档位: ${leaf.maxTier})`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ 大群创建完成！");
  console.log("=".repeat(60));
  console.log(`\n📋 合约地址汇总:`);
  console.log(`   UNICHAT: ${unichat.address}`);
  console.log(`   Factory: ${factory.address}`);
  console.log(`   Community: ${communityAddress}`);
  console.log(`\n💾 保存这些地址以便后续使用`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

