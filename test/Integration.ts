import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, encodePacked, type Address } from "viem";
import { MerkleTree, computeLeaf, type MerkleLeaf } from "../scripts/utils/merkleTree.js";

describe("集成测试：完整群聊流程", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  it("应该完成完整的群聊流程", async function () {
    const [deployer, treasury, communityOwner, alice, bob, charlie] = await viem.getWalletClients();

    console.log("\n" + "=".repeat(60));
    console.log("🚀 开始集成测试：完整群聊流程");
    console.log("=".repeat(60));

    // ========== 第一步：部署所有合约 ==========
    console.log("\n📦 第一步：部署合约...");
    
    const unichat = await viem.deployContract("MockUNICHAT");
    console.log(`   ✅ UNICHAT: ${unichat.address}`);

    const communityImpl = await viem.deployContract("Community");
    const roomImpl = await viem.deployContract("Room");
    console.log(`   ✅ 实现合约已部署`);

    const factory = await viem.deployContract("CommunityFactory", [
      unichat.address,
      treasury.account.address,
      parseEther("50"),
      communityImpl.address,
      roomImpl.address,
    ]);
    console.log(`   ✅ Factory: ${factory.address}`);

    // ========== 第二步：创建大群 ==========
    console.log("\n🏘️  第二步：创建大群...");
    
    const createTx = await factory.write.createCommunity([communityOwner.account.address]);
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTx });
    const createLogs = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "CommunityCreated",
      fromBlock: createReceipt.blockNumber,
      toBlock: createReceipt.blockNumber,
    });

    const communityAddress = createLogs[0].args.community as Address;
    const community = await viem.getContractAt("Community", communityAddress);
    console.log(`   ✅ Community: ${communityAddress}`);

    // ========== 第三步：生成 Merkle Tree 并设置 Root ==========
    console.log("\n🌳 第三步：生成 Merkle Tree...");
    
    const epoch = 1n;
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
    const nonce = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;

    const whitelist: MerkleLeaf[] = [
      {
        community: communityAddress,
        epoch,
        account: alice.account.address,
        maxTier: 3n,
        validUntil,
        nonce,
      },
      {
        community: communityAddress,
        epoch,
        account: bob.account.address,
        maxTier: 2n,
        validUntil,
        nonce,
      },
      {
        community: communityAddress,
        epoch,
        account: charlie.account.address,
        maxTier: 1n,
        validUntil,
        nonce,
      },
    ];

    const leaves = whitelist.map(computeLeaf);
    const tree = new MerkleTree(leaves);
    const root = tree.getRoot();

    console.log(`   ✅ Merkle Root: ${root.slice(0, 10)}...`);
    console.log(`   ✅ 白名单用户: Alice(档位3), Bob(档位2), Charlie(档位1)`);

    // 设置 Merkle Root
    await community.write.setMerkleRoot(
      [root, "ipfs://whitelist-v1"],
      { account: communityOwner.account }
    );
    console.log(`   ✅ Merkle Root 已设置`);

    // ========== 第四步：用户加入大群 ==========
    console.log("\n👥 第四步：用户加入大群...");
    
    const users = [alice, bob, charlie];
    for (let i = 0; i < whitelist.length; i++) {
      const leaf = whitelist[i];
      const leafHash = computeLeaf(leaf);
      const proof = tree.getProof(leafHash);

      await community.write.joinCommunity(
        [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, proof],
        { account: users[i].account }
      );
      
      const isActive = await community.read.isActiveMember([leaf.account]);
      assert.equal(isActive, true);
      console.log(`   ✅ ${["Alice", "Bob", "Charlie"][i]} 已加入 (档位: ${leaf.maxTier})`);
    }

    // ========== 第五步：给用户分发代币 ==========
    console.log("\n💰 第五步：分发 UNICHAT 代币...");
    
    await unichat.write.mint([alice.account.address, parseEther("1000")]);
    await unichat.write.mint([bob.account.address, parseEther("1000")]);
    await unichat.write.mint([charlie.account.address, parseEther("1000")]);
    console.log(`   ✅ 每个用户获得 1000 UNICHAT`);

    // ========== 第六步：Alice 创建小群 ==========
    console.log("\n🏠 第六步：Alice 创建小群...");
    
    await unichat.write.approve(
      [community.address, parseEther("50")],
      { account: alice.account }
    );

    const treasuryBalanceBefore = await unichat.read.balanceOf([treasury.account.address]);

    const createRoomTx = await community.write.createRoom(
      [{ inviteFee: parseEther("5"), plaintextEnabled: true, messageMaxBytes: 2048 }],
      { account: alice.account }
    );
    const roomReceipt = await publicClient.waitForTransactionReceipt({ hash: createRoomTx });
    const roomLogs = await publicClient.getContractEvents({
      address: community.address,
      abi: community.abi,
      eventName: "RoomCreated",
      fromBlock: roomReceipt.blockNumber,
      toBlock: roomReceipt.blockNumber,
    });

    const roomAddress = roomLogs[0].args.room as Address;
    const room = await viem.getContractAt("Room", roomAddress);
    console.log(`   ✅ Room: ${roomAddress}`);
    console.log(`   ✅ 邀请费: 5 UNICHAT`);

    // 验证创建费已支付
    const treasuryBalanceAfter = await unichat.read.balanceOf([treasury.account.address]);
    assert.equal(treasuryBalanceAfter - treasuryBalanceBefore, parseEther("50"));
    console.log(`   ✅ 创建费 50 UNICHAT 已支付给金库`);

    // ========== 第七步：Alice 邀请 Bob 和 Charlie ==========
    console.log("\n📨 第七步：Alice 邀请成员...");
    
    // 邀请 Bob
    await unichat.write.approve(
      [room.address, parseEther("5")],
      { account: alice.account }
    );
    await room.write.invite([bob.account.address], { account: alice.account });
    console.log(`   ✅ Bob 已被邀请`);

    // 邀请 Charlie
    await unichat.write.approve(
      [room.address, parseEther("5")],
      { account: alice.account }
    );
    await room.write.invite([charlie.account.address], { account: alice.account });
    console.log(`   ✅ Charlie 已被邀请`);

    const membersCount = await room.read.membersCount();
    assert.equal(membersCount, 3n);
    console.log(`   ✅ 小群成员数: ${membersCount}`);

    // ========== 第八步：成员发送消息 ==========
    console.log("\n💬 第八步：成员发送消息...");
    
    const messages = [
      { sender: alice, text: "大家好！欢迎来到我的小群！" },
      { sender: bob, text: "谢谢邀请！" },
      { sender: charlie, text: "很高兴加入！" },
    ];

    for (const msg of messages) {
      const content = encodePacked(["string"], [msg.text]);
      const tx = await room.write.sendMessage(
        [0, content, ""],
        { account: msg.sender.account }
      );
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log(`   ✅ ${msg.sender === alice ? "Alice" : msg.sender === bob ? "Bob" : "Charlie"}: ${msg.text}`);
    }

    const messageCount = await room.read.messageCount();
    assert.equal(messageCount, 3n);

    // ========== 第九步：读取消息历史 ==========
    console.log("\n📖 第九步：读取消息历史...");
    
    for (let i = 0; i < 3; i++) {
      const message = await room.read.getMessage([BigInt(i)]);
      const sender = message[0];
      const content = message[3];
      console.log(`   📝 消息 ${i + 1}: ${sender.slice(0, 6)}... 发送`);
    }

    // ========== 第十步：Bob 离开小群 ==========
    console.log("\n🚪 第十步：Bob 离开小群...");
    
    const epochBefore = await room.read.groupKeyEpoch();
    await room.write.leave({ account: bob.account });
    const epochAfter = await room.read.groupKeyEpoch();

    const bobIsMember = await room.read.isMember([bob.account.address]);
    const finalMembersCount = await room.read.membersCount();

    assert.equal(bobIsMember, false);
    assert.equal(finalMembersCount, 2n);
    assert.equal(epochAfter, epochBefore + 1n);
    console.log(`   ✅ Bob 已离开`);
    console.log(`   ✅ 群密钥 epoch 已更新: ${epochBefore} → ${epochAfter}`);
    console.log(`   ✅ 剩余成员: ${finalMembersCount}`);

    // ========== 第十一步：发送密文消息 ==========
    console.log("\n🔐 第十一步：发送密文消息...");
    
    const encryptedContent = encodePacked(["string"], ["encrypted_message_data"]);
    const tx = await room.write.sendMessage(
      [1, encryptedContent, "QmEncrypted123"],
      { account: alice.account }
    );
    await publicClient.waitForTransactionReceipt({ hash: tx });

    const lastMessage = await room.read.getMessage([3n]);
    assert.equal(lastMessage[2], 1); // kind = encrypted
    console.log(`   ✅ Alice 发送了密文消息`);

    // ========== 第十二步：验证最终状态 ==========
    console.log("\n✅ 第十二步：验证最终状态...");
    
    const finalMessageCount = await room.read.messageCount();
    const aliceIsMember = await room.read.isMember([alice.account.address]);
    const charlieIsMember = await room.read.isMember([charlie.account.address]);

    assert.equal(finalMessageCount, 4n);
    assert.equal(aliceIsMember, true);
    assert.equal(charlieIsMember, true);
    assert.equal(bobIsMember, false);

    console.log(`   ✅ 总消息数: ${finalMessageCount}`);
    console.log(`   ✅ Alice 在群中: ${aliceIsMember}`);
    console.log(`   ✅ Charlie 在群中: ${charlieIsMember}`);
    console.log(`   ✅ Bob 已离开: ${!bobIsMember}`);

    console.log("\n" + "=".repeat(60));
    console.log("🎉 集成测试完成！所有功能正常运行！");
    console.log("=".repeat(60));
    console.log("\n📊 测试覆盖：");
    console.log("   ✅ 合约部署");
    console.log("   ✅ 大群创建");
    console.log("   ✅ Merkle Tree 验证");
    console.log("   ✅ 用户加入大群");
    console.log("   ✅ 小群创建与费用支付");
    console.log("   ✅ 成员邀请");
    console.log("   ✅ 明文消息发送");
    console.log("   ✅ 密文消息发送");
    console.log("   ✅ 成员离开");
    console.log("   ✅ 群密钥轮换");
    console.log("   ✅ 消息历史读取\n");
  });
});

