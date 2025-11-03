import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { network } from "hardhat";
import { parseEther, encodePacked, type Address } from "viem";
import { MerkleTree, computeLeaf, type MerkleLeaf } from "../scripts/utils/merkleTree.js";

describe("Room", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  let unichat: any;
  let community: any;
  let room: any;
  let deployer: any;
  let communityOwner: any;
  let user1: any;
  let user2: any;
  let user3: any;
  let treasury: any;

  beforeEach(async () => {
    const clients = await viem.getWalletClients();
    [deployer, treasury, communityOwner, user1, user2, user3] = clients;

    // 部署基础合约
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

    // 设置 Merkle Tree 并让用户加入
    const epoch = 1n;
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
    const nonce = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;

    const whitelist: MerkleLeaf[] = [
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
    const tree = new MerkleTree(leaves);
    const root = tree.getRoot();

    await community.write.setMerkleRoot(
      [root, "ipfs://whitelist"],
      { account: communityOwner.account }
    );

    // 所有用户加入大群
    for (const leaf of whitelist) {
      const leafHash = computeLeaf(leaf);
      const proof = tree.getProof(leafHash);
      const userClient = leaf.account === user1.account.address ? user1 :
                         leaf.account === user2.account.address ? user2 : user3;
      await community.write.joinCommunity(
        [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, proof],
        { account: userClient.account }
      );
    }

    // 给用户铸造代币
    await unichat.write.mint([user1.account.address, parseEther("1000")]);
    await unichat.write.mint([user2.account.address, parseEther("1000")]);
    await unichat.write.mint([user3.account.address, parseEther("1000")]);

    // User1 创建小群
    await unichat.write.approve(
      [community.address, parseEther("50")],
      { account: user1.account }
    );

    const createTx = await community.write.createRoom(
      [{ inviteFee: parseEther("10"), plaintextEnabled: true, messageMaxBytes: 1024 }],
      { account: user1.account }
    );
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTx });
    const roomLogs = await publicClient.getContractEvents({
      address: community.address,
      abi: community.abi,
      eventName: "RoomCreated",
      fromBlock: createReceipt.blockNumber,
      toBlock: createReceipt.blockNumber,
    });

    const roomAddress = roomLogs[0].args.room as Address;
    room = await viem.getContractAt("Room", roomAddress);
  });

  describe("基本配置", () => {
    it("应该正确初始化", async function () {
      const owner = await room.read.owner();
      const inviteFee = await room.read.inviteFee();
      const plaintextEnabled = await room.read.plaintextEnabled();
      const messageMaxBytes = await room.read.messageMaxBytes();
      const membersCount = await room.read.membersCount();

      assert.equal(owner.toLowerCase(), user1.account.address.toLowerCase());
      assert.equal(inviteFee, parseEther("10"));
      assert.equal(plaintextEnabled, true);
      assert.equal(messageMaxBytes, 1024);
      assert.equal(membersCount, 1n); // 创建者自动加入
    });

    it("应该能更新邀请费", async function () {
      const newFee = parseEther("20");
      await room.write.setInviteFee([newFee], { account: user1.account });

      const inviteFee = await room.read.inviteFee();
      assert.equal(inviteFee, newFee);
    });

    it("应该能更新费用接收人", async function () {
      await room.write.setFeeRecipient([user2.account.address], { account: user1.account });

      const feeRecipient = await room.read.feeRecipient();
      assert.equal(feeRecipient.toLowerCase(), user2.account.address.toLowerCase());
    });

    it("只有 owner 可以更新配置", async function () {
      await assert.rejects(
        async () => {
          await room.write.setInviteFee([parseEther("20")], { account: user2.account });
        },
        /NotOwner/
      );
    });
  });

  describe("成员管理", () => {
    it("应该能邀请新成员", async function () {
      // User1 邀请 User2
      await unichat.write.approve(
        [room.address, parseEther("10")],
        { account: user1.account }
      );

      const tx = await room.write.invite([user2.account.address], { account: user1.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: room.address,
        abi: room.abi,
        eventName: "Invited",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal(logs[0].args.user?.toLowerCase(), user2.account.address.toLowerCase());
      assert.equal(logs[0].args.inviter?.toLowerCase(), user1.account.address.toLowerCase());
      assert.equal(logs[0].args.fee, parseEther("10"));

      // 验证成员状态
      const isMember = await room.read.isMember([user2.account.address]);
      const membersCount = await room.read.membersCount();
      assert.equal(isMember, true);
      assert.equal(membersCount, 2n);
    });

    it("邀请应该增加 groupKeyEpoch", async function () {
      const epochBefore = await room.read.groupKeyEpoch();

      await unichat.write.approve(
        [room.address, parseEther("10")],
        { account: user1.account }
      );
      await room.write.invite([user2.account.address], { account: user1.account });

      const epochAfter = await room.read.groupKeyEpoch();
      assert.equal(epochAfter, epochBefore + 1n);
    });

    it("不能邀请已经是成员的用户", async function () {
      await unichat.write.approve(
        [room.address, parseEther("10")],
        { account: user1.account }
      );
      await room.write.invite([user2.account.address], { account: user1.account });

      await assert.rejects(
        async () => {
          await unichat.write.approve(
            [room.address, parseEther("10")],
            { account: user1.account }
          );
          await room.write.invite([user2.account.address], { account: user1.account });
        },
        /AlreadyMember/
      );
    });

    it("不能邀请非大群成员", async function () {
      const [, , , , , , nonMember] = await viem.getWalletClients();

      await assert.rejects(
        async () => {
          await room.write.invite([nonMember.account.address], { account: user1.account });
        },
        /NotCommunityMember/
      );
    });

    it("owner 应该能踢出成员", async function () {
      // 先邀请 user2
      await unichat.write.approve(
        [room.address, parseEther("10")],
        { account: user1.account }
      );
      await room.write.invite([user2.account.address], { account: user1.account });

      // 踢出 user2
      const tx = await room.write.kick([user2.account.address], { account: user1.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: room.address,
        abi: room.abi,
        eventName: "Kicked",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal(logs[0].args.user?.toLowerCase(), user2.account.address.toLowerCase());

      // 验证状态
      const isMember = await room.read.isMember([user2.account.address]);
      const membersCount = await room.read.membersCount();
      assert.equal(isMember, false);
      assert.equal(membersCount, 1n);
    });

    it("成员应该能主动离开", async function () {
      // 先邀请 user2
      await unichat.write.approve(
        [room.address, parseEther("10")],
        { account: user1.account }
      );
      await room.write.invite([user2.account.address], { account: user1.account });

      // User2 离开
      const tx = await room.write.leave([], { account: user2.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: room.address,
        abi: room.abi,
        eventName: "Left",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal(logs[0].args.user?.toLowerCase(), user2.account.address.toLowerCase());

      // 验证状态
      const isMember = await room.read.isMember([user2.account.address]);
      assert.equal(isMember, false);
    });
  });

  describe("消息功能", () => {
    beforeEach(async () => {
      // 邀请 user2 加入小群
      await unichat.write.approve(
        [room.address, parseEther("10")],
        { account: user1.account }
      );
      await room.write.invite([user2.account.address], { account: user1.account });
    });

    it("应该能发送明文消息", async function () {
      const content = encodePacked(["string"], ["Hello, World!"]);
      const cid = "QmTest123";

      const tx = await room.write.sendMessage(
        [0, content, cid],
        { account: user1.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: room.address,
        abi: room.abi,
        eventName: "MessageBroadcasted",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal(logs[0].args.sender?.toLowerCase(), user1.account.address.toLowerCase());
      assert.equal(logs[0].args.kind, 0);
      assert.equal(logs[0].args.seq, 1n);
      assert.equal(logs[0].args.cid, cid);

      // 验证存储
      const messageCount = await room.read.messageCount();
      assert.equal(messageCount, 1n);

      const message = await room.read.getMessage([0n]);
      assert.equal(message[0].toLowerCase(), user1.account.address.toLowerCase()); // sender
      assert.equal(message[2], 0); // kind
      assert.equal(message[3], content); // content
      assert.equal(message[4], cid); // cid
    });

    it("应该能发送密文消息", async function () {
      const encryptedContent = encodePacked(["string"], ["encrypted_data_here"]);
      const cid = "QmEncrypted456";

      const tx = await room.write.sendMessage(
        [1, encryptedContent, cid],
        { account: user1.account }
      );
      await publicClient.waitForTransactionReceipt({ hash: tx });

      const message = await room.read.getMessage([0n]);
      assert.equal(message[2], 1); // kind = encrypted
    });

    it("非成员不能发送消息", async function () {
      const content = encodePacked(["string"], ["Hello"]);

      await assert.rejects(
        async () => {
          await room.write.sendMessage(
            [0, content, ""],
            { account: user3.account }
          );
        },
        /NotMember/
      );
    });

    it("应该拒绝超长消息", async function () {
      const longContent = encodePacked(["string"], ["x".repeat(2000)]);

      await assert.rejects(
        async () => {
          await room.write.sendMessage(
            [0, longContent, ""],
            { account: user1.account }
          );
        },
        /TooLarge/
      );
    });

    it("关闭明文后不能发送明文消息", async function () {
      await room.write.setPlaintextEnabled([false], { account: user1.account });

      const content = encodePacked(["string"], ["Hello"]);

      await assert.rejects(
        async () => {
          await room.write.sendMessage(
            [0, content, ""],
            { account: user1.account }
          );
        },
        /PlaintextOff/
      );
    });

    it("应该能读取多条消息", async function () {
      // 发送 3 条消息
      for (let i = 0; i < 3; i++) {
        const content = encodePacked(["string"], [`Message ${i}`]);
        await room.write.sendMessage(
          [0, content, `cid${i}`],
          { account: user1.account }
        );
      }

      const messageCount = await room.read.messageCount();
      assert.equal(messageCount, 3n);

      // 读取所有消息
      for (let i = 0; i < 3; i++) {
        const message = await room.read.getMessage([BigInt(i)]);
        assert.equal(message[4], `cid${i}`);
      }
    });
  });

  describe("群密钥轮换", () => {
    it("owner 应该能手动轮换密钥", async function () {
      const epochBefore = await room.read.groupKeyEpoch();
      const metadataHash = "0x1234567890123456789012345678901234567890123456789012345678901234" as `0x${string}`;

      const tx = await room.write.rotateEpoch([metadataHash], { account: user1.account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: room.address,
        abi: room.abi,
        eventName: "GroupKeyEpochIncreased",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal(logs[0].args.epoch, epochBefore + 1n);
      assert.equal(logs[0].args.metadataHash, metadataHash);

      const epochAfter = await room.read.groupKeyEpoch();
      assert.equal(epochAfter, epochBefore + 1n);
    });
  });
});

