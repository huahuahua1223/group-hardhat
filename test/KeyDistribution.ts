import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { network } from "hardhat";
import { parseEther, keccak256, encodePacked, encodeAbiParameters, type Address } from "viem";
import { MerkleTree } from "merkletreejs";

/**
 * @title KeyDistribution 测试
 * @notice 测试群主分发群密钥功能
 * @dev 模拟完整的密钥分发流程：
 *      1. 群主生成 RSA 公钥并设置
 *      2. 成员加入大群
 *      3. 群主获取活跃成员列表
 *      4. 为每个成员加密群密钥（模拟）
 *      5. 构建 Merkle Tree
 *      6. 上传加密密钥文件到 IPFS（模拟）
 *      7. 调用 distributeGroupKey 保存 Merkle Root 和 CID
 *      8. 成员验证自己的加密密钥
 */
describe("KeyDistribution - 群密钥分发", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  let unichat: any;
  let community: any;
  let deployer: any;
  let communityOwner: any;
  let user1: any;
  let user2: any;
  let user3: any;
  let user4: any;
  let user5: any;
  let treasury: any;

  // 辅助函数：计算 Merkle Leaf
  function computeKeyLeaf(account: Address, encryptedKey: string): `0x${string}` {
    return keccak256(encodePacked(["address", "bytes"], [account, encodeAbiParameters([{ type: "string" }], [encryptedKey])]));
  }

  beforeEach(async () => {
    const clients = await viem.getWalletClients();
    [deployer, treasury, communityOwner, user1, user2, user3, user4, user5] = clients;

    // 部署合约
    unichat = await viem.deployContract("MockUNICHAT");
    const communityImpl = await viem.deployContract("Community");
    const roomImpl = await viem.deployContract("Room");

    const factory = await viem.deployContract("CommunityFactory", [
      unichat.address,
      treasury.account.address,
      parseEther("50"),
      communityImpl.address,
      roomImpl.address,
    ]);

    // 创建 Community
    const tx = await factory.write.createCommunity([
      communityOwner.account.address,
      unichat.address,
      3,
      "测试大群",
      "QmTestAvatar",
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    const logs = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "CommunityCreated",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });

    const communityAddress = logs[0].args.community as Address;
    community = await viem.getContractAt("Community", communityAddress);
  });

  describe("密钥分发基础功能", () => {
    it("应该能设置 RSA 群聊公钥", async function () {
      const rsaPublicKey = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1234567890abcdef...
-----END PUBLIC KEY-----`;
      const metadataHash = keccak256(encodePacked(["string"], ["metadata"]));

      const tx = await community.write.setRsaGroupPublicKey(
        [rsaPublicKey, metadataHash],
        { account: communityOwner.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: community.address,
        abi: community.abi,
        eventName: "RsaGroupPublicKeyUpdated",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal((logs[0] as any).args.epoch, 1n);
      assert.equal((logs[0] as any).args.rsaPublicKey, rsaPublicKey);

      // 验证状态
      const storedKey = await community.read.getRsaGroupPublicKey();
      assert.equal(storedKey, rsaPublicKey);

      const epoch = await community.read.getGroupKeyEpoch();
      assert.equal(epoch, 1n);
    });

    it("应该能分发群密钥", async function () {
      const merkleRoot = keccak256(encodePacked(["string"], ["test_root"]));
      const ipfsCid = "QmTest123456789abcdefghijklmnopqrstuvwxyz";

      const tx = await community.write.distributeGroupKey(
        [merkleRoot, ipfsCid],
        { account: communityOwner.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: community.address,
        abi: community.abi,
        eventName: "KeyDistributed",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal((logs[0] as any).args.distributionEpoch, 1n);
      assert.equal((logs[0] as any).args.merkleRoot, merkleRoot);
      assert.equal((logs[0] as any).args.ipfsCid, ipfsCid);

      // 验证状态
      const currentEpoch = await community.read.currentDistributionEpoch();
      assert.equal(currentEpoch, 1n);

      const distribution = await community.read.getKeyDistribution([1n]);
      assert.equal(distribution[0], merkleRoot); // merkleRoot
      assert.equal(distribution[1], ipfsCid);    // ipfsCid
      assert.equal(distribution[2], 1n);          // epoch
      assert.ok(distribution[3] > 0n);            // timestamp
    });

    it("只有群主可以分发群密钥", async function () {
      const merkleRoot = keccak256(encodePacked(["string"], ["test"]));
      const ipfsCid = "QmTest123";

      await assert.rejects(
        async () => {
          await community.write.distributeGroupKey(
            [merkleRoot, ipfsCid],
            { account: user1.account }
          );
        },
        /NotOwner|OwnableUnauthorizedAccount/
      );
    });

    it("不能使用零 Merkle Root", async function () {
      const zeroRoot = "0x0000000000000000000000000000000000000000000000000000000000000000";
      const ipfsCid = "QmTest123";

      await assert.rejects(
        async () => {
          await community.write.distributeGroupKey(
            [zeroRoot, ipfsCid],
            { account: communityOwner.account }
          );
        },
        /ZeroRoot/
      );
    });

    it("不能使用空 IPFS CID", async function () {
      const merkleRoot = keccak256(encodePacked(["string"], ["test"]));
      const emptyCid = "";

      await assert.rejects(
        async () => {
          await community.write.distributeGroupKey(
            [merkleRoot, emptyCid],
            { account: communityOwner.account }
          );
        },
        /EmptyCid/
      );
    });

    it("应该能获取最新的密钥分发信息", async function () {
      // 第一次分发
      const root1 = keccak256(encodePacked(["string"], ["test1"]));
      await community.write.distributeGroupKey(
        [root1, "QmCid1"],
        { account: communityOwner.account }
      );

      // 第二次分发
      const root2 = keccak256(encodePacked(["string"], ["test2"]));
      await community.write.distributeGroupKey(
        [root2, "QmCid2"],
        { account: communityOwner.account }
      );

      // 获取最新分发信息
      const latest = await community.read.getLatestKeyDistribution();
      assert.equal(latest[0], root2);      // merkleRoot
      assert.equal(latest[1], "QmCid2");   // ipfsCid
      assert.equal(latest[2], 2n);         // epoch
      assert.ok(latest[3] > 0n);           // timestamp
    });

    it("未分发密钥时获取最新分发应返回空数据", async function () {
      const latest = await community.read.getLatestKeyDistribution();
      assert.equal(latest[0], "0x0000000000000000000000000000000000000000000000000000000000000000");
      assert.equal(latest[1], "");
      assert.equal(latest[2], 0n);  // epoch
      assert.equal(latest[3], 0);  // timestamp
    });
  });

  describe("完整密钥分发流程", () => {
    it("应该完成完整的密钥分发和验证流程", async function () {
      // 步骤 1: 群主设置 RSA 公钥
      const rsaPublicKey = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBg...test...";
      await community.write.setRsaGroupPublicKey(
        [rsaPublicKey, keccak256(encodePacked(["string"], ["v1"]))],
        { account: communityOwner.account }
      );

      // 步骤 2: 群主直接邀请成员加入大群
      await community.write.inviteMember(
        [user1.account.address, 1n],
        { account: communityOwner.account }
      );
      await community.write.inviteMember(
        [user2.account.address, 2n],
        { account: communityOwner.account }
      );
      await community.write.inviteMember(
        [user3.account.address, 3n],
        { account: communityOwner.account }
      );

      // 验证成员数量
      const activeMemberCount = await community.read.getActiveMembersCount();
      assert.equal(activeMemberCount, 3n);

      // 步骤 3: 获取活跃成员列表
      const activeMembers = await community.read.getActiveMembers([0n, 10n]);
      assert.equal(activeMembers.length, 3);

      // 步骤 4: 模拟为每个成员加密群密钥
      const groupKey = "my-secret-group-key-12345";
      const encryptedKeys = [
        { address: user1.account.address, encryptedKey: `encrypted_for_${user1.account.address.slice(2, 10)}` },
        { address: user2.account.address, encryptedKey: `encrypted_for_${user2.account.address.slice(2, 10)}` },
        { address: user3.account.address, encryptedKey: `encrypted_for_${user3.account.address.slice(2, 10)}` },
      ];

      // 步骤 5: 构建 Merkle Tree
      const leaves = encryptedKeys.map(item => 
        computeKeyLeaf(item.address as Address, item.encryptedKey)
      );
      const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
      const merkleRoot = merkleTree.getRoot();

      // 步骤 6: 模拟上传到 IPFS
      const ipfsCid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

      // 步骤 7: 群主分发群密钥
      const tx = await community.write.distributeGroupKey(
        [`0x${merkleRoot.toString("hex")}`, ipfsCid],
        { account: communityOwner.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: community.address,
        abi: community.abi,
        eventName: "KeyDistributed",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal((logs[0] as any).args.distributionEpoch, 1n);
      assert.equal((logs[0] as any).args.ipfsCid, ipfsCid);

      // 步骤 8: 每个成员验证自己的加密密钥
      for (let i = 0; i < encryptedKeys.length; i++) {
        const item = encryptedKeys[i];
        const leaf = computeKeyLeaf(item.address as Address, item.encryptedKey);
        const proof = merkleTree.getHexProof(leaf);

        const isValid = await community.read.verifyEncryptedKey([
          1n, // distributionEpoch
          item.address,
          encodeAbiParameters([{ type: "string" }], [item.encryptedKey]),
          proof as `0x${string}`[],
        ]);

        assert.equal(isValid, true, `成员 ${item.address} 的密钥验证应该通过`);
      }

      // 步骤 9: 验证错误的加密密钥应该失败
      const wrongKey = "wrong_encrypted_key";
      const wrongLeaf = computeKeyLeaf(user1.account.address, wrongKey);
      const wrongProof = merkleTree.getHexProof(wrongLeaf);

      const isInvalid = await community.read.verifyEncryptedKey([
        1n,
        user1.account.address,
        encodeAbiParameters([{ type: "string" }], [wrongKey]),
        wrongProof as `0x${string}`[],
      ]);

      assert.equal(isInvalid, false, "错误的密钥应该验证失败");
    });

    it("应该支持多次密钥分发（密钥轮换）", async function () {
      // 邀请成员
      await community.write.inviteMember(
        [user1.account.address, 1n],
        { account: communityOwner.account }
      );
      await community.write.inviteMember(
        [user2.account.address, 2n],
        { account: communityOwner.account }
      );

      // 第一次分发
      const encryptedKeys1 = [
        { address: user1.account.address, encryptedKey: "encrypted_v1_user1" },
        { address: user2.account.address, encryptedKey: "encrypted_v1_user2" },
      ];
      const leaves1 = encryptedKeys1.map(item => 
        computeKeyLeaf(item.address as Address, item.encryptedKey)
      );
      const merkleTree1 = new MerkleTree(leaves1, keccak256, { sortPairs: true });
      const root1 = `0x${merkleTree1.getRoot().toString("hex")}`;

      await community.write.distributeGroupKey(
        [root1, "QmCid1"],
        { account: communityOwner.account }
      );

      // 新增一个成员
      await community.write.inviteMember(
        [user3.account.address, 3n],
        { account: communityOwner.account }
      );

      // 第二次分发（包含新成员）
      const encryptedKeys2 = [
        { address: user1.account.address, encryptedKey: "encrypted_v2_user1" },
        { address: user2.account.address, encryptedKey: "encrypted_v2_user2" },
        { address: user3.account.address, encryptedKey: "encrypted_v2_user3" },
      ];
      const leaves2 = encryptedKeys2.map(item => 
        computeKeyLeaf(item.address as Address, item.encryptedKey)
      );
      const merkleTree2 = new MerkleTree(leaves2, keccak256, { sortPairs: true });
      const root2 = `0x${merkleTree2.getRoot().toString("hex")}`;

      await community.write.distributeGroupKey(
        [root2, "QmCid2"],
        { account: communityOwner.account }
      );

      // 验证两个版本的分发记录
      const dist1 = await community.read.getKeyDistribution([1n]);
      assert.equal(dist1[0], root1);
      assert.equal(dist1[1], "QmCid1");

      const dist2 = await community.read.getKeyDistribution([2n]);
      assert.equal(dist2[0], root2);
      assert.equal(dist2[1], "QmCid2");

      // 验证最新版本
      const latest = await community.read.getLatestKeyDistribution();
      assert.equal(latest[0], root2);
      assert.equal(latest[2], 2n);

      // user3 应该能验证第二版密钥
      const item = encryptedKeys2[2];
      const leaf = computeKeyLeaf(item.address as Address, item.encryptedKey);
      const proof = merkleTree2.getHexProof(leaf);

      const isValid = await community.read.verifyEncryptedKey([
        2n,
        item.address,
        encodeAbiParameters([{ type: "string" }], [item.encryptedKey]),
        proof as `0x${string}`[],
      ]);

      assert.equal(isValid, true);
    });

    it("应该处理大量成员的密钥分发", async function () {
      // 邀请多个成员
      const users = [user1, user2, user3, user4, user5];
      for (let i = 0; i < users.length; i++) {
        await community.write.inviteMember(
          [users[i].account.address, (i % 3) + 1],
          { account: communityOwner.account }
        );
      }

      // 为每个成员生成加密密钥
      const encryptedKeys = users.map((user, index) => ({
        address: user.account.address,
        encryptedKey: `encrypted_key_${index}_${user.account.address.slice(2, 10)}`,
      }));

      // 构建 Merkle Tree
      const leaves = encryptedKeys.map(item => 
        computeKeyLeaf(item.address as Address, item.encryptedKey)
      );
      const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
      const root = `0x${merkleTree.getRoot().toString("hex")}`;

      // 分发密钥
      await community.write.distributeGroupKey(
        [root, "QmLargeDistribution"],
        { account: communityOwner.account }
      );

      // 随机验证几个成员的密钥
      const testIndexes = [0, 2, 4];
      for (const index of testIndexes) {
        const item = encryptedKeys[index];
        const leaf = computeKeyLeaf(item.address as Address, item.encryptedKey);
        const proof = merkleTree.getHexProof(leaf);

        const isValid = await community.read.verifyEncryptedKey([
          1n,
          item.address,
          encodeAbiParameters([{ type: "string" }], [item.encryptedKey]),
          proof as `0x${string}`[],
        ]);

        assert.equal(isValid, true, `成员 ${index} 的密钥验证失败`);
      }
    });

    it("非分发版本的验证应该失败", async function () {
      await community.write.inviteMember(
        [user1.account.address, 1n],
        { account: communityOwner.account }
      );

      const encryptedKey = "test_encrypted_key";
      const leaf = computeKeyLeaf(user1.account.address, encryptedKey);
      const merkleTree = new MerkleTree([leaf], keccak256, { sortPairs: true });
      const proof = merkleTree.getHexProof(leaf);

      // 查询不存在的分发版本
      const isValid = await community.read.verifyEncryptedKey([
        999n, // 不存在的版本
        user1.account.address,
        encodeAbiParameters([{ type: "string" }], [encryptedKey]),
        proof as `0x${string}`[],
      ]);

      assert.equal(isValid, false);
    });
  });

  describe("与现有功能集成", () => {
    it("密钥分发应该与 RSA 公钥设置协同工作", async function () {
      // 设置 RSA 公钥
      const rsaKey = "-----BEGIN PUBLIC KEY-----\nTest...";
      await community.write.setRsaGroupPublicKey(
        [rsaKey, keccak256(encodePacked(["string"], ["v1"]))],
        { account: communityOwner.account }
      );

      const rsaEpoch = await community.read.getGroupKeyEpoch();
      assert.equal(rsaEpoch, 1n);

      // 分发群密钥
      await community.write.inviteMember(
        [user1.account.address, 1n],
        { account: communityOwner.account }
      );

      const encryptedKeys = [
        { address: user1.account.address, encryptedKey: "encrypted_key_1" },
      ];
      const leaves = encryptedKeys.map(item => 
        computeKeyLeaf(item.address as Address, item.encryptedKey)
      );
      const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
      const root = `0x${merkleTree.getRoot().toString("hex")}`;

      await community.write.distributeGroupKey(
        [root, "QmTest"],
        { account: communityOwner.account }
      );

      const distEpoch = await community.read.currentDistributionEpoch();
      assert.equal(distEpoch, 1n);

      // 验证两个 epoch 独立工作
      assert.equal(rsaEpoch, distEpoch);
    });

    it("只有活跃成员应该被包含在密钥分发中", async function () {
      // 设置 Merkle Root 并邀请成员
      const root = keccak256(encodePacked(["string"], ["test"]));
      await community.write.setMerkleRoot(
        [root, "ipfs://test"],
        { account: communityOwner.account }
      );

      await community.write.inviteMember(
        [user1.account.address, 1n],
        { account: communityOwner.account }
      );
      await community.write.inviteMember(
        [user2.account.address, 2n],
        { account: communityOwner.account }
      );

      // 获取活跃成员
      const activeMembers = await community.read.getActiveMembers([0n, 10n]);
      assert.equal(activeMembers.length, 2);

      // 为活跃成员分发密钥
      const encryptedKeys = activeMembers.map((addr: Address, index: number) => ({
        address: addr,
        encryptedKey: `encrypted_${index}`,
      }));

      const leaves = encryptedKeys.map((item: { address: Address; encryptedKey: string }) => 
        computeKeyLeaf(item.address, item.encryptedKey)
      );
      const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
      const merkleRoot = `0x${merkleTree.getRoot().toString("hex")}`;

      await community.write.distributeGroupKey(
        [merkleRoot, "QmActiveMembers"],
        { account: communityOwner.account }
      );

      // 验证活跃成员可以验证密钥
      for (let i = 0; i < encryptedKeys.length; i++) {
        const item = encryptedKeys[i];
        const leaf = computeKeyLeaf(item.address as Address, item.encryptedKey);
        const proof = merkleTree.getHexProof(leaf);

        const isValid = await community.read.verifyEncryptedKey([
          1n,
          item.address,
          encodeAbiParameters([{ type: "string" }], [item.encryptedKey]),
          proof as `0x${string}`[],
        ]);

        assert.equal(isValid, true);
      }
    });
  });
});

