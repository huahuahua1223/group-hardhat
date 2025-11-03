import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { network } from "hardhat";
import { parseEther, keccak256, encodePacked, type Address } from "viem";
import { MerkleTree, computeLeaf, type MerkleLeaf } from "../scripts/utils/merkleTree.js";

describe("Community", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  let unichat: any;
  let community: any;
  let roomImpl: any;
  let deployer: any;
  let communityOwner: any;
  let user1: any;
  let user2: any;
  let user3: any;
  let treasury: any;

  beforeEach(async () => {
    const clients = await viem.getWalletClients();
    [deployer, treasury, communityOwner, user1, user2, user3] = clients;

    // 部署合约
    unichat = await viem.deployContract("MockUNICHAT");
    const communityImpl = await viem.deployContract("Community");
    roomImpl = await viem.deployContract("Room");

    const factory = await viem.deployContract("CommunityFactory", [
      unichat.address,
      treasury.account.address,
      parseEther("50"),
      communityImpl.address,
      roomImpl.address,
    ]);

    // 创建 Community
    const tx = await factory.write.createCommunity([communityOwner.account.address]);
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

  describe("Merkle Root 管理", () => {
    it("应该能设置 Merkle Root", async function () {
      const root = keccak256(encodePacked(["string"], ["test"]));
      const uri = "ipfs://QmTest123";

      const tx = await community.write.setMerkleRoot(
        [root, uri],
        { account: communityOwner.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: community.address,
        abi: community.abi,
        eventName: "MerkleRootUpdated",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal((logs[0] as any).args.epoch, 1n);
      assert.equal((logs[0] as any).args.root, root);
      assert.equal((logs[0] as any).args.uri, uri);

      // 验证状态
      const currentEpoch = await community.read.currentEpoch();
      assert.equal(currentEpoch, 1n);

      const storedRoot = await community.read.merkleRoots([1n]);
      assert.equal(storedRoot, root);
    });

    it("只有 owner 可以设置 Merkle Root", async function () {
      const root = keccak256(encodePacked(["string"], ["test"]));
      
      await assert.rejects(
        async () => {
          await community.write.setMerkleRoot(
            [root, "ipfs://test"],
            { account: user1.account }
          );
        },
        /OwnableUnauthorizedAccount/
      );
    });

    it("不应该接受零 root", async function () {
      const zeroRoot = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
      
      await assert.rejects(
        async () => {
          await community.write.setMerkleRoot(
            [zeroRoot, "ipfs://test"],
            { account: communityOwner.account }
          );
        },
        /ZeroRoot/
      );
    });
  });

  describe("Merkle Proof 验证与加入", () => {
    let tree: MerkleTree;
    let whitelist: MerkleLeaf[];
    let root: `0x${string}`;

    beforeEach(async () => {
      // 设置 Merkle Tree
      const epoch = 1n;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
      const nonce = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;

      whitelist = [
        {
          community: community.address,
          epoch,
          account: user1.account.address,
          maxTier: 3n,
          validUntil,
          nonce,
        },
        {
          community: community.address,
          epoch,
          account: user2.account.address,
          maxTier: 2n,
          validUntil,
          nonce,
        },
        {
          community: community.address,
          epoch,
          account: user3.account.address,
          maxTier: 1n,
          validUntil,
          nonce,
        },
      ];

      const leaves = whitelist.map(computeLeaf);
      tree = new MerkleTree(leaves);
      root = tree.getRoot();

      // 设置 root
      await community.write.setMerkleRoot(
        [root, "ipfs://whitelist"],
        { account: communityOwner.account }
      );
    });

    it("应该能验证有效的 proof（链上）", async function () {
      const leaf = whitelist[0];
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

      assert.equal(eligible, true);
    });

    it("应该拒绝无效的 proof", async function () {
      const leaf = whitelist[0];
      const fakeProof = [keccak256(encodePacked(["string"], ["fake"]))];

      const eligible = await community.read.eligible([
        leaf.account,
        leaf.maxTier,
        leaf.epoch,
        leaf.validUntil,
        leaf.nonce,
        fakeProof,
      ]);

      assert.equal(eligible, false);
    });

    it("应该能加入大群", async function () {
      const leaf = whitelist[0];
      const leafHash = computeLeaf(leaf);
      const proof = tree.getProof(leafHash);

      const tx = await community.write.joinCommunity(
        [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, proof],
        { account: user1.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: community.address,
        abi: community.abi,
        eventName: "Joined",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal((logs[0] as any).args.account?.toLowerCase(), user1.account.address.toLowerCase());
      assert.equal((logs[0] as any).args.tier, 3n);
      assert.equal((logs[0] as any).args.epoch, 1n);

      // 验证状态
      const isMember = await community.read.isMember([user1.account.address]);
      const tier = await community.read.memberTier([user1.account.address]);
      const lastEpoch = await community.read.lastJoinedEpoch([user1.account.address]);
      const isActive = await community.read.isActiveMember([user1.account.address]);

      assert.equal(isMember, true);
      assert.equal(tier, 3n);
      assert.equal(lastEpoch, 1n);
      assert.equal(isActive, true);
    });

    it("应该拒绝错误的 epoch", async function () {
      const leaf = { ...whitelist[0], epoch: 2n };
      const leafHash = computeLeaf(leaf);
      const proof = tree.getProof(computeLeaf(whitelist[0]));

      await assert.rejects(
        async () => {
          await community.write.joinCommunity(
            [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, proof],
            { account: user1.account }
          );
        },
        /EpochMismatch/
      );
    });

    it("应该拒绝错误的 proof", async function () {
      const leaf = whitelist[0];
      const fakeProof = [keccak256(encodePacked(["string"], ["fake"]))];

      await assert.rejects(
        async () => {
          await community.write.joinCommunity(
            [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, fakeProof],
            { account: user1.account }
          );
        },
        /BadProof/
      );
    });
  });

  describe("创建小群", () => {
    let tree: MerkleTree;
    let whitelist: MerkleLeaf[];

    beforeEach(async () => {
      // 设置并加入大群
      const epoch = 1n;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
      const nonce = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;

      whitelist = [
        {
          community: community.address,
          epoch,
          account: user1.account.address,
          maxTier: 3n,
          validUntil,
          nonce,
        },
      ];

      const leaves = whitelist.map(computeLeaf);
      tree = new MerkleTree(leaves);
      const root = tree.getRoot();

      await community.write.setMerkleRoot(
        [root, "ipfs://whitelist"],
        { account: communityOwner.account }
      );

      // User1 加入大群
      const leaf = whitelist[0];
      const leafHash = computeLeaf(leaf);
      const proof = tree.getProof(leafHash);
      await community.write.joinCommunity(
        [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, proof],
        { account: user1.account }
      );

      // 给 user1 铸造代币并授权
      await unichat.write.mint([user1.account.address, parseEther("1000")]);
      await unichat.write.approve(
        [community.address, parseEther("50")],
        { account: user1.account }
      );
    });

    it("应该能创建小群", async function () {
      const tx = await community.write.createRoom(
        [{ inviteFee: parseEther("10"), plaintextEnabled: true, messageMaxBytes: 1024 }],
        { account: user1.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: community.address,
        abi: community.abi,
        eventName: "RoomCreated",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal((logs[0] as any).args.owner?.toLowerCase(), user1.account.address.toLowerCase());
      assert.equal((logs[0] as any).args.inviteFee, parseEther("10"));

      const roomAddress = (logs[0] as any).args.room as Address;
      assert.notEqual(roomAddress, "0x0000000000000000000000000000000000000000");

      // 验证 Room 已正确初始化
      const room = await viem.getContractAt("Room", roomAddress);
      const owner = await room.read.owner();
      assert.equal(owner.toLowerCase(), user1.account.address.toLowerCase());
    });

    it("非成员不能创建小群", async function () {
      await assert.rejects(
        async () => {
          await community.write.createRoom(
            [{ inviteFee: parseEther("10"), plaintextEnabled: true, messageMaxBytes: 1024 }],
            { account: user2.account }
          );
        },
        /NotActiveMember/
      );
    });
  });
});

