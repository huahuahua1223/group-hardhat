import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address } from "viem";
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
    
    const createTx = await factory.write.createCommunity([
      communityOwner.account.address,
      unichat.address, // topicToken
      5, // maxTier
      "集成测试大群",
      "QmIntegrationTestAvatar",
    ]);
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
    console.log(`   ✅ 主题代币: UNICHAT, 档位: 5`);

    // ========== 第三步：生成 Merkle Tree 并设置 Root ==========
    console.log("\n🌳 第三步：生成 Merkle Tree...");
    
    const epoch = 1n;
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
    
    // 为每个用户生成唯一的 nonce
    const nonce1 = `0x${Date.now().toString(16).padStart(64, '0')}` as `0x${string}`;
    const nonce2 = `0x${(Date.now() + 1).toString(16).padStart(64, '0')}` as `0x${string}`;
    const nonce3 = `0x${(Date.now() + 2).toString(16).padStart(64, '0')}` as `0x${string}`;

    const whitelist: MerkleLeaf[] = [
      {
        community: communityAddress,
        epoch,
        account: alice.account.address,
        maxTier: 3n,
        validUntil,
        nonce: nonce1,
      },
      {
        community: communityAddress,
        epoch,
        account: bob.account.address,
        maxTier: 2n,
        validUntil,
        nonce: nonce2,
      },
      {
        community: communityAddress,
        epoch,
        account: charlie.account.address,
        maxTier: 1n,
        validUntil,
        nonce: nonce3,
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

    const createRoomTx = await community.write.createRoom({ account: alice.account });
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
    console.log(`   ✅ 邀请费: 0 UNICHAT (使用大群默认值)`);

    // 验证创建费已支付
    const treasuryBalanceAfter = await unichat.read.balanceOf([treasury.account.address]);
    assert.equal(treasuryBalanceAfter - treasuryBalanceBefore, parseEther("50"));
    console.log(`   ✅ 创建费 50 UNICHAT 已支付给金库`);

    // ========== 第七步：Alice 在第一个小群邀请 Bob（邀请费为 0）==========
    console.log("\n📨 第七步：Alice 在第一个小群邀请 Bob（邀请费为 0）...");
    
    // 验证第一个小群的邀请费是 0
    const firstRoomInviteFee = await room.read.inviteFee();
    assert.equal(firstRoomInviteFee, 0n);
    console.log(`   ✅ 第一个小群邀请费: ${firstRoomInviteFee} UNICHAT`);
    
    // 邀请 Bob（邀请费为 0，无需 approve）
    await room.write.invite([bob.account.address], { account: alice.account });
    console.log(`   ✅ Bob 已被邀请到第一个小群`);

    const firstRoomMembersCount = await room.read.membersCount();
    assert.equal(firstRoomMembersCount, 2n);
    console.log(`   ✅ 第一个小群成员数: ${firstRoomMembersCount}`);

    // ========== 第八步：大群群主设置默认邀请费为 10 UNICHAT ==========
    console.log("\n⚙️  第八步：大群群主设置默认邀请费为 10 UNICHAT...");
    
    const newDefaultInviteFee = parseEther("10");
    await community.write.setDefaultRoomParams(
      [newDefaultInviteFee, true],
      { account: communityOwner.account }
    );
    
    // 验证默认邀请费已更新
    const defaultInviteFee = await community.read.defaultInviteFee();
    assert.equal(defaultInviteFee, newDefaultInviteFee);
    console.log(`   ✅ 默认邀请费已更新为: ${newDefaultInviteFee / BigInt(1e18)} UNICHAT`);

    // ========== 第九步：Bob 创建第二个小群（使用新的默认邀请费 10）==========
    console.log("\n🏠 第九步：Bob 创建第二个小群（使用新的默认邀请费）...");
    
    await unichat.write.approve(
      [community.address, parseEther("50")],
      { account: bob.account }
    );

    const createRoom2Tx = await community.write.createRoom({ account: bob.account });
    const room2Receipt = await publicClient.waitForTransactionReceipt({ hash: createRoom2Tx });
    const room2Logs = await publicClient.getContractEvents({
      address: community.address,
      abi: community.abi,
      eventName: "RoomCreated",
      fromBlock: room2Receipt.blockNumber,
      toBlock: room2Receipt.blockNumber,
    });

    const room2Address = room2Logs[0].args.room as Address;
    const room2 = await viem.getContractAt("Room", room2Address);
    console.log(`   ✅ 第二个 Room: ${room2Address}`);
    
    // 验证第二个小群的邀请费是新设置的 10 UNICHAT
    const secondRoomInviteFee = await room2.read.inviteFee();
    assert.equal(secondRoomInviteFee, newDefaultInviteFee);
    console.log(`   ✅ 第二个小群邀请费: ${secondRoomInviteFee / BigInt(1e18)} UNICHAT (使用新的默认值)`);

    // ========== 第十步：Bob 先邀请 Alice 进入第二个小群（Bob 自己付费给自己）==========
    console.log("\n💰 第十步：Bob 先邀请 Alice 进入第二个小群...");
    
    // 验证第二个小群的 feeRecipient 是 Bob（创建者）
    const room2FeeRecipient = await room2.read.feeRecipient();
    assert.equal(room2FeeRecipient.toLowerCase(), bob.account.address.toLowerCase());
    console.log(`   ✅ 第二个小群的费用接收人是 Bob（创建者）`);

    // Bob 授权 10 UNICHAT 给第二个小群合约
    await unichat.write.approve(
      [room2.address, newDefaultInviteFee],
      { account: bob.account }
    );

    // Bob 邀请 Alice 到第二个小群
    await room2.write.invite([alice.account.address], { account: bob.account });
    console.log(`   ✅ Alice 已被邀请到第二个小群（Bob 付费给自己）`);

    const room2MembersCountAfterAlice = await room2.read.membersCount();
    assert.equal(room2MembersCountAfterAlice, 2n);

    // ========== 第十一步：Alice 在第二个小群邀请 Charlie（付费给 Bob）==========
    console.log("\n💵 第十一步：Alice 在第二个小群邀请 Charlie（需要支付邀请费给 Bob）...");
    
    // 记录 Alice 和 Bob 的余额（邀请前）
    const aliceBalanceBefore = await unichat.read.balanceOf([alice.account.address]);
    const bobBalanceBefore = await unichat.read.balanceOf([bob.account.address]);
    
    // Alice 授权 10 UNICHAT 给第二个小群合约
    await unichat.write.approve(
      [room2.address, newDefaultInviteFee],
      { account: alice.account }
    );
    console.log(`   ✅ Alice 已授权 ${newDefaultInviteFee / BigInt(1e18)} UNICHAT 给第二个小群`);

    // Alice 邀请 Charlie 到第二个小群
    const inviteTx = await room2.write.invite([charlie.account.address], { account: alice.account });
    const inviteReceipt = await publicClient.waitForTransactionReceipt({ hash: inviteTx });
    console.log(`   ✅ Charlie 已被邀请到第二个小群`);

    // 验证邀请事件
    const inviteLogs = await publicClient.getContractEvents({
      address: room2.address,
      abi: room2.abi,
      eventName: "Invited",
      fromBlock: inviteReceipt.blockNumber,
      toBlock: inviteReceipt.blockNumber,
    });
    assert.equal(inviteLogs.length, 1);
    assert.equal((inviteLogs[0].args as any).fee, newDefaultInviteFee);
    console.log(`   ✅ Invited 事件已触发，邀请费: ${newDefaultInviteFee / BigInt(1e18)} UNICHAT`);

    // 验证余额变化：Alice 减少 10 UNICHAT，Bob 增加 10 UNICHAT
    const aliceBalanceAfter = await unichat.read.balanceOf([alice.account.address]);
    const bobBalanceAfter = await unichat.read.balanceOf([bob.account.address]);
    assert.equal(aliceBalanceBefore - aliceBalanceAfter, newDefaultInviteFee);
    assert.equal(bobBalanceAfter - bobBalanceBefore, newDefaultInviteFee);
    console.log(`   ✅ Alice 已支付 ${newDefaultInviteFee / BigInt(1e18)} UNICHAT 邀请费给 Bob`);
    console.log(`   ✅ Bob 已收到 ${newDefaultInviteFee / BigInt(1e18)} UNICHAT 邀请费`);

    // 验证 Charlie 是第二个小群的成员
    const isCharlieInRoom2 = await room2.read.isMember([charlie.account.address]);
    assert.equal(isCharlieInRoom2, true);
    
    const secondRoomMembersCount = await room2.read.membersCount();
    assert.equal(secondRoomMembersCount, 3n);
    console.log(`   ✅ 第二个小群成员数: ${secondRoomMembersCount}`);

    // ========== 第十二步：Alice 在第一个小群继续邀请 Charlie（邀请费仍为 0）==========
    console.log("\n📨 第十二步：Alice 在第一个小群继续邀请 Charlie（邀请费仍为 0）...");
    
    // 验证第一个小群的邀请费仍然是 0（不受默认参数修改影响）
    const stillZeroInviteFee = await room.read.inviteFee();
    assert.equal(stillZeroInviteFee, 0n);
    console.log(`   ✅ 第一个小群邀请费仍为: ${stillZeroInviteFee} UNICHAT`);
    
    // Alice 邀请 Charlie 到第一个小群（无需 approve）
    await room.write.invite([charlie.account.address], { account: alice.account });
    console.log(`   ✅ Charlie 已被邀请到第一个小群`);

    const finalFirstRoomMembersCount = await room.read.membersCount();
    assert.equal(finalFirstRoomMembersCount, 3n);
    console.log(`   ✅ 第一个小群最终成员数: ${finalFirstRoomMembersCount}`);

    // ========== 第十三步：成员在第一个小群发送消息 ==========
    console.log("\n💬 第十三步：成员在第一个小群发送消息...");
    
    const messages = [
      { sender: alice, text: "大家好！欢迎来到我的小群！" },
      { sender: bob, text: "谢谢邀请！" },
      { sender: charlie, text: "很高兴加入！" },
    ];

    for (const msg of messages) {
      const tx = await room.write.sendMessage(
        [0, msg.text, ""],
        { account: msg.sender.account }
      );
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log(`   ✅ ${msg.sender === alice ? "Alice" : msg.sender === bob ? "Bob" : "Charlie"}: ${msg.text}`);
    }

    const messageCount = await room.read.messageCount();
    assert.equal(messageCount, 3n);

    // ========== 第十四步：读取消息历史 ==========
    console.log("\n📖 第十四步：读取消息历史...");
    
    // 单条读取
    for (let i = 0; i < 3; i++) {
      const message = await room.read.getMessage([BigInt(i)]);
      const sender = message[0];
      const content = message[3];
      console.log(`   📝 消息 ${i + 1}: ${sender.slice(0, 6)}... 发送: "${content}"`);
    }

    // 分页读取测试
    console.log("\n📄 测试分页读取消息...");
    const allMessages = await room.read.getMessages([0n, 10n]);
    assert.equal(allMessages.length, 3);
    console.log(`   ✅ 分页读取成功，获取到 ${allMessages.length} 条消息`);
    
    // 验证消息内容
    assert.equal(allMessages[0].content, "大家好！欢迎来到我的小群！");
    assert.equal(allMessages[1].content, "谢谢邀请！");
    assert.equal(allMessages[2].content, "很高兴加入！");
    console.log(`   ✅ 消息内容验证通过`);

    // ========== 第十五步：Bob 离开第一个小群 ==========
    console.log("\n🚪 第十五步：Bob 离开第一个小群...");
    
    const epochBefore = await room.read.groupKeyEpoch();
    await room.write.leave({ account: bob.account });
    const epochAfter = await room.read.groupKeyEpoch();

    const bobIsMemberRoom1 = await room.read.isMember([bob.account.address]);
    const finalMembersCountRoom1 = await room.read.membersCount();

    assert.equal(bobIsMemberRoom1, false);
    assert.equal(finalMembersCountRoom1, 2n);
    assert.equal(epochAfter, epochBefore + 1n);
    console.log(`   ✅ Bob 已离开第一个小群`);
    console.log(`   ✅ 群密钥 epoch 已更新: ${epochBefore} → ${epochAfter}`);
    console.log(`   ✅ 剩余成员: ${finalMembersCountRoom1}`);

    // ========== 第十六步：发送密文消息 ==========
    console.log("\n🔐 第十六步：发送密文消息...");
    
    const encryptedContent = "encrypted_message_data";
    const tx = await room.write.sendMessage(
      [1, encryptedContent, "QmEncrypted123"],
      { account: alice.account }
    );
    await publicClient.waitForTransactionReceipt({ hash: tx });

    const lastMessage = await room.read.getMessage([3n]);
    assert.equal(lastMessage[2], 1); // kind = encrypted
    console.log(`   ✅ Alice 发送了密文消息`);

    // ========== 第十七步：验证最终状态 ==========
    console.log("\n✅ 第十七步：验证最终状态...");
    
    const finalMessageCount = await room.read.messageCount();
    const aliceIsMemberRoom1 = await room.read.isMember([alice.account.address]);
    const aliceIsMemberRoom2 = await room2.read.isMember([alice.account.address]);
    const charlieIsMemberRoom1 = await room.read.isMember([charlie.account.address]);
    const bobIsMemberRoom2 = await room2.read.isMember([bob.account.address]);
    const charlieIsMemberRoom2 = await room2.read.isMember([charlie.account.address]);

    assert.equal(finalMessageCount, 4n);
    assert.equal(aliceIsMemberRoom1, true);
    assert.equal(aliceIsMemberRoom2, true);
    assert.equal(charlieIsMemberRoom1, true);
    assert.equal(bobIsMemberRoom1, false);
    assert.equal(bobIsMemberRoom2, true);
    assert.equal(charlieIsMemberRoom2, true);

    console.log(`   ✅ 第一个小群总消息数: ${finalMessageCount}`);
    console.log(`   ✅ 第一个小群 - Alice 在群中: ${aliceIsMemberRoom1}`);
    console.log(`   ✅ 第一个小群 - Charlie 在群中: ${charlieIsMemberRoom1}`);
    console.log(`   ✅ 第一个小群 - Bob 已离开: ${!bobIsMemberRoom1}`);
    console.log(`   ✅ 第二个小群 - Alice 在群中: ${aliceIsMemberRoom2}`);
    console.log(`   ✅ 第二个小群 - Bob 在群中: ${bobIsMemberRoom2}`);
    console.log(`   ✅ 第二个小群 - Charlie 在群中: ${charlieIsMemberRoom2}`);

    console.log("\n" + "=".repeat(60));
    console.log("🎉 集成测试完成！所有功能正常运行！");
    console.log("=".repeat(60));
    console.log("\n📊 测试覆盖：");
    console.log("   ✅ 合约部署");
    console.log("   ✅ 大群创建");
    console.log("   ✅ Merkle Tree 验证");
    console.log("   ✅ 用户加入大群");
    console.log("   ✅ 小群创建与费用支付");
    console.log("   ✅ 成员邀请（免费邀请）");
    console.log("   ✅ 大群群主修改默认邀请费");
    console.log("   ✅ 修改默认参数后创建新小群（使用新参数）");
    console.log("   ✅ 付费邀请（approve + 支付代币）");
    console.log("   ✅ 已存在小群不受默认参数修改影响");
    console.log("   ✅ 明文消息发送（字符串格式）");
    console.log("   ✅ 密文消息发送（字符串格式）");
    console.log("   ✅ 消息历史读取（单条 + 分页）");
    console.log("   ✅ 成员离开");
    console.log("   ✅ 群密钥轮换");
    console.log("   ✅ 多小群并存验证\n");
  });
});

