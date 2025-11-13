import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address, keccak256, encodePacked } from "viem";
import { MerkleTree } from "merkletreejs";

describe("CommunityDiscovery - 群聊发现功能", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  let unichat: any;
  let communityImpl: any;
  let roomImpl: any;
  let factory: any;
  let deployer: any;
  let treasury: any;
  let communityOwner1: any;
  let communityOwner2: any;
  let communityOwner3: any;
  let user1: any;

  // 存储创建的 Community 地址
  let community1: Address;
  let community2: Address;
  let community3: Address;

  beforeEach(async () => {
    const clients = await viem.getWalletClients();
    [deployer, treasury, communityOwner1, communityOwner2, communityOwner3, user1] = clients;

    // 部署 UNICHAT 代币
    unichat = await viem.deployContract("MockUNICHAT");

    // 部署实现合约
    communityImpl = await viem.deployContract("Community");
    roomImpl = await viem.deployContract("Room");

    // 部署 Factory
    factory = await viem.deployContract("CommunityFactory", [
      unichat.address,
      treasury.account.address,
      parseEther("50"),
      communityImpl.address,
      roomImpl.address,
    ]);

    // 创建三个不同的 Community
    // Community 1: 主题代币 = unichat, maxTier = 3
    const tx1 = await factory.write.createCommunity([
      communityOwner1.account.address,
      unichat.address,
      3,
      "测试大群1",
      "QmAvatar1",
    ]);
    const receipt1 = await publicClient.waitForTransactionReceipt({ hash: tx1 });
    const logs1 = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "CommunityCreated",
      fromBlock: receipt1.blockNumber,
      toBlock: receipt1.blockNumber,
    });
    community1 = (logs1[0] as any).args.community as Address;

    // Community 2: 主题代币 = unichat, maxTier = 5
    const tx2 = await factory.write.createCommunity([
      communityOwner2.account.address,
      unichat.address,
      5,
      "测试大群2",
      "QmAvatar2",
    ]);
    const receipt2 = await publicClient.waitForTransactionReceipt({ hash: tx2 });
    const logs2 = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "CommunityCreated",
      fromBlock: receipt2.blockNumber,
      toBlock: receipt2.blockNumber,
    });
    community2 = (logs2[0] as any).args.community as Address;

    // 部署第二个代币作为不同的主题代币
    const token2 = await viem.deployContract("MockUNICHAT");

    // Community 3: 主题代币 = token2, maxTier = 7
    const tx3 = await factory.write.createCommunity([
      communityOwner3.account.address,
      token2.address,
      7,
      "测试大群3",
      "QmAvatar3",
    ]);
    const receipt3 = await publicClient.waitForTransactionReceipt({ hash: tx3 });
    const logs3 = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "CommunityCreated",
      fromBlock: receipt3.blockNumber,
      toBlock: receipt3.blockNumber,
    });
    community3 = (logs3[0] as any).args.community as Address;
  });

  describe("基础查询功能", () => {
    it("应该能获取所有群聊总数", async function () {
      const count = await factory.read.getAllCommunitiesCount();
      assert.equal(count, 3n);
    });

    it("应该能分页获取群聊列表", async function () {
      // 获取前 2 个
      const communities = await factory.read.getCommunities([0n, 2n]);
      assert.equal(communities.length, 2);
      assert.equal(communities[0].toLowerCase(), community1.toLowerCase());
      assert.equal(communities[1].toLowerCase(), community2.toLowerCase());

      // 获取后 2 个（第 2 和第 3 个）
      const communities2 = await factory.read.getCommunities([1n, 2n]);
      assert.equal(communities2.length, 2);
      assert.equal(communities2[0].toLowerCase(), community2.toLowerCase());
      assert.equal(communities2[1].toLowerCase(), community3.toLowerCase());

      // 获取全部
      const allCommunities = await factory.read.getCommunities([0n, 10n]);
      assert.equal(allCommunities.length, 3);
    });

    it("分页查询超出范围时应该返回空数组", async function () {
      const communities = await factory.read.getCommunities([10n, 5n]);
      assert.equal(communities.length, 0);
    });

    it("应该能按主题代币查询群聊", async function () {
      const communitiesByTopic = await factory.read.getCommunitiesByTopic([unichat.address]);
      assert.equal(communitiesByTopic.length, 2);
      assert.equal(communitiesByTopic[0].toLowerCase(), community1.toLowerCase());
      assert.equal(communitiesByTopic[1].toLowerCase(), community2.toLowerCase());
    });

    it("应该能分页获取指定主题代币的群聊", async function () {
      const communities = await factory.read.getCommunitiesByTopicPaginated([
        unichat.address,
        0n,
        1n,
      ]);
      assert.equal(communities.length, 1);
      assert.equal(communities[0].toLowerCase(), community1.toLowerCase());
    });
  });

  describe("批量元数据查询", () => {
    it("应该能批量获取群聊元数据", async function () {
      const metadata = await factory.read.batchGetCommunityMetadata([
        [community1, community2, community3],
      ]);

      assert.equal(metadata.length, 3);

      // 验证第一个群聊
      assert.equal(metadata[0].communityAddress.toLowerCase(), community1.toLowerCase());
      assert.equal(metadata[0].owner.toLowerCase(), communityOwner1.account.address.toLowerCase());
      assert.equal(metadata[0].topicToken.toLowerCase(), unichat.address.toLowerCase());
      assert.equal(metadata[0].maxTier, 3);
      assert.equal(metadata[0].name, "测试大群1");
      assert.equal(metadata[0].avatarCid, "QmAvatar1");
      assert.equal(metadata[0].currentEpoch, 0n);

      // 验证第二个群聊
      assert.equal(metadata[1].communityAddress.toLowerCase(), community2.toLowerCase());
      assert.equal(metadata[1].owner.toLowerCase(), communityOwner2.account.address.toLowerCase());
      assert.equal(metadata[1].maxTier, 5);
      assert.equal(metadata[1].name, "测试大群2");

      // 验证第三个群聊
      assert.equal(metadata[2].communityAddress.toLowerCase(), community3.toLowerCase());
      assert.equal(metadata[2].maxTier, 7);
      assert.equal(metadata[2].name, "测试大群3");
    });

    it("应该能处理无效地址", async function () {
      const invalidAddress = "0x0000000000000000000000000000000000000001" as Address;
      const metadata = await factory.read.batchGetCommunityMetadata([
        [community1, invalidAddress],
      ]);

      assert.equal(metadata.length, 2);
      // 第一个应该是正常数据
      assert.equal(metadata[0].name, "测试大群1");
      // 第二个应该是默认数据
      assert.equal(metadata[1].communityAddress.toLowerCase(), invalidAddress.toLowerCase());
      assert.equal(metadata[1].owner, "0x0000000000000000000000000000000000000000");
      assert.equal(metadata[1].name, "");
    });
  });

  describe("批量资格检查", () => {
    it("应该能批量检查用户资格（无 Merkle Root 时应该返回 false）", async function () {
      // 创建测试数据（没有设置 Merkle Root，所以都应该返回 false）
      const results = await factory.read.batchCheckEligibility([
        user1.account.address,
        [community1, community2],
        [3n, 5n], // tiers
        [0n, 0n], // epochs
        [0n, 0n], // validUntils
        [keccak256(encodePacked(["string"], ["nonce1"])), keccak256(encodePacked(["string"], ["nonce2"]))],
        [[], []], // empty proofs
      ]);

      assert.equal(results.length, 2);
      assert.equal(results[0], false);
      assert.equal(results[1], false);
    });

    it("应该能批量检查用户资格（设置 Merkle Root 后）", async function () {
      // 为 community1 设置 Merkle Root
      const community1Contract = await viem.getContractAt("Community", community1);

      // 创建简单的 Merkle Tree
      const epoch = 1n;
      const maxTier = 3n;
      const validUntil = 0n;
      const nonce = keccak256(encodePacked(["string"], ["test-nonce"]));

      // 计算叶子节点
      const leaf = keccak256(
        encodePacked(
          ["address", "uint256", "address", "uint256", "uint256", "bytes32"],
          [community1, epoch, user1.account.address, maxTier, validUntil, nonce]
        )
      );

      // 创建 Merkle Tree
      const leaves = [leaf];
      const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
      const root = tree.getRoot();
      const proof = tree.getHexProof(leaf);

      // 设置 Merkle Root（作为群主）
      await community1Contract.write.setMerkleRoot([`0x${root.toString("hex")}`, "test-uri"], {
        account: communityOwner1.account,
      });

      // 批量检查资格
      const results = await factory.read.batchCheckEligibility([
        user1.account.address,
        [community1, community2],
        [maxTier, 5n],
        [epoch, 0n],
        [validUntil, 0n],
        [nonce, keccak256(encodePacked(["string"], ["other-nonce"]))],
        [proof as `0x${string}`[], []],
      ]);

      assert.equal(results.length, 2);
      assert.equal(results[0], true); // community1 应该有资格
      assert.equal(results[1], false); // community2 没有设置 Merkle Root
    });
  });

  describe("Community.getMetadata 函数", () => {
    it("应该能直接从 Community 获取元数据", async function () {
      const community1Contract = await viem.getContractAt("Community", community1);
      const metadata = await community1Contract.read.getMetadata();

      assert.equal(metadata[0].toLowerCase(), unichat.address.toLowerCase()); // topicToken
      assert.equal(metadata[1], 3); // maxTier
      assert.equal(metadata[2], "测试大群1"); // name
      assert.equal(metadata[3], "QmAvatar1"); // avatarCid
      assert.equal(metadata[4].toLowerCase(), communityOwner1.account.address.toLowerCase()); // owner
      assert.equal(metadata[5], 0n); // currentEpoch
    });
  });

  describe("集成场景：用户发现可加入的群聊", () => {
    it("模拟用户发现流程", async function () {
      // 步骤 1: 用户查询所有群聊总数
      const totalCount = await factory.read.getAllCommunitiesCount();
      console.log(`发现 ${totalCount} 个群聊`);
      assert.equal(totalCount, 3n);

      // 步骤 2: 分页获取群聊列表
      const allCommunities = await factory.read.getCommunities([0n, totalCount]);
      console.log(`获取到 ${allCommunities.length} 个群聊地址`);

      // 步骤 3: 批量获取元数据
      const metadata = await factory.read.batchGetCommunityMetadata([allCommunities]);
      console.log("群聊列表:");
      metadata.forEach((m: any, i: number) => {
        console.log(`  ${i + 1}. ${m.name} (档位: ${m.maxTier}, epoch: ${m.currentEpoch})`);
      });

      // 步骤 4: 按主题代币筛选
      const unichatCommunities = await factory.read.getCommunitiesByTopic([unichat.address]);
      console.log(`使用 UNICHAT 的群聊有 ${unichatCommunities.length} 个`);
      assert.equal(unichatCommunities.length, 2);

      // 步骤 5: 获取筛选后的元数据
      const filteredMetadata = await factory.read.batchGetCommunityMetadata([
        unichatCommunities,
      ]);
      assert.equal(filteredMetadata.length, 2);
      assert.equal(filteredMetadata[0].name, "测试大群1");
      assert.equal(filteredMetadata[1].name, "测试大群2");
    });
  });
});

