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
    const tx = await factory.write.createCommunity([
      communityOwner.account.address,
      unichat.address, // topicToken
      3, // maxTier
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
      
      // 为每个用户生成唯一的 nonce
      const nonce1 = `0x${Date.now().toString(16).padStart(64, '0')}` as `0x${string}`;
      const nonce2 = `0x${(Date.now() + 1).toString(16).padStart(64, '0')}` as `0x${string}`;
      const nonce3 = `0x${(Date.now() + 2).toString(16).padStart(64, '0')}` as `0x${string}`;

      whitelist = [
        {
          community: community.address,
          epoch,
          account: user1.account.address,
          maxTier: 3n,
          validUntil,
          nonce: nonce1,
        },
        {
          community: community.address,
          epoch,
          account: user2.account.address,
          maxTier: 2n,
          validUntil,
          nonce: nonce2,
        },
        {
          community: community.address,
          epoch,
          account: user3.account.address,
          maxTier: 1n,
          validUntil,
          nonce: nonce3,
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

    it("不同用户可以使用相同的 nonce", async function () {
      // 使用相同的 nonce 为两个用户创建白名单
      const sameNonce = `0x${'0'.repeat(63)}1` as `0x${string}`;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
      
      // 获取当前 epoch，新的 epoch 将是 currentEpoch + 1
      const currentEpoch = await community.read.currentEpoch();
      const nextEpoch = currentEpoch + 1n;
      
      // 创建新白名单，两个用户使用相同的 nonce 和正确的 epoch
      const newWhitelist: MerkleLeaf[] = [
        {
          community: community.address,
          epoch: nextEpoch,
          account: user1.account.address,
          maxTier: 3n,
          validUntil,
          nonce: sameNonce,
        },
        {
          community: community.address,
          epoch: nextEpoch,
          account: user2.account.address,
          maxTier: 2n,
          validUntil,
          nonce: sameNonce,
        },
      ];
      
      // 使用正确的 epoch 生成 tree 和 root
      const leaves = newWhitelist.map(computeLeaf);
      const newTree = new MerkleTree(leaves);
      const newRoot = newTree.getRoot();
      
      // 更新 Merkle Root
      await community.write.setMerkleRoot(
        [newRoot, "ipfs://same-nonce-test"],
        { account: communityOwner.account }
      );

      // user1 使用 nonce 加入
      const user1Leaf = newWhitelist[0];
      const user1Proof = newTree.getProof(computeLeaf(user1Leaf));
      await community.write.joinCommunity(
        [user1Leaf.maxTier, user1Leaf.epoch, user1Leaf.validUntil, user1Leaf.nonce, user1Proof],
        { account: user1.account }
      );

      // 验证 user1 的 nonce 已被使用
      const user1NonceUsed = await community.read.usedNonces([user1.account.address, sameNonce]);
      assert.equal(user1NonceUsed, true);

      // user2 使用相同的 nonce 加入（应该成功，因为是不同用户）
      const user2Leaf = newWhitelist[1];
      const user2Proof = newTree.getProof(computeLeaf(user2Leaf));
      await community.write.joinCommunity(
        [user2Leaf.maxTier, user2Leaf.epoch, user2Leaf.validUntil, user2Leaf.nonce, user2Proof],
        { account: user2.account }
      );

      // 验证 user2 的 nonce 也被标记为已使用
      const user2NonceUsed = await community.read.usedNonces([user2.account.address, sameNonce]);
      assert.equal(user2NonceUsed, true);

      // 验证两个用户都成功加入
      const user1IsMember = await community.read.isActiveMember([user1.account.address]);
      const user2IsMember = await community.read.isActiveMember([user2.account.address]);
      assert.equal(user1IsMember, true);
      assert.equal(user2IsMember, true);
    });

    it("同一用户不能重复使用相同的 nonce", async function () {
      const leaf = whitelist[0];
      const leafHash = computeLeaf(leaf);
      const proof = tree.getProof(leafHash);

      // 第一次加入成功
      await community.write.joinCommunity(
        [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, proof],
        { account: user1.account }
      );

      // 尝试用相同的 nonce 再次加入（应该失败）
      await assert.rejects(
        async () => {
          await community.write.joinCommunity(
            [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, proof],
            { account: user1.account }
          );
        },
        /NonceUsed/
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
      
      // 为每个用户生成唯一的 nonce
      const nonce = `0x${Date.now().toString(16).padStart(64, '0')}` as `0x${string}`;

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
      const tx = await community.write.createRoom({ account: user1.account });
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
      assert.equal((logs[0] as any).args.inviteFee, 0n); // 使用默认值 0

      const roomAddress = (logs[0] as any).args.room as Address;
      assert.notEqual(roomAddress, "0x0000000000000000000000000000000000000000");

      // 验证 Room 已正确初始化
      const room = await viem.getContractAt("Room", roomAddress);
      const owner = await room.read.owner();
      assert.equal(owner.toLowerCase(), user1.account.address.toLowerCase());
      
      // 验证使用了大群的默认参数
      const inviteFee = await room.read.inviteFee();
      const plaintextEnabled = await room.read.plaintextEnabled();
      const messageMaxBytes = await room.read.messageMaxBytes();
      assert.equal(inviteFee, 0n);
      assert.equal(plaintextEnabled, true);
      assert.equal(messageMaxBytes, 2048); // 固定为 2048
    });

    it("非成员不能创建小群", async function () {
      await assert.rejects(
        async () => {
          await community.write.createRoom({ account: user2.account });
        },
        /NotActiveMember/
      );
    });

    it("大群群主应该能设置默认参数", async function () {
      // 设置新的默认参数
      const newInviteFee = parseEther("5");
      const newPlaintextEnabled = false;

      const tx = await community.write.setDefaultRoomParams(
        [newInviteFee, newPlaintextEnabled],
        { account: communityOwner.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: community.address,
        abi: community.abi,
        eventName: "DefaultRoomParamsUpdated",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal((logs[0] as any).args.defaultInviteFee, newInviteFee);
      assert.equal((logs[0] as any).args.defaultPlaintextEnabled, newPlaintextEnabled);

      // 验证状态已更新
      const defaultInviteFee = await community.read.defaultInviteFee();
      const defaultPlaintextEnabled = await community.read.defaultPlaintextEnabled();
      assert.equal(defaultInviteFee, newInviteFee);
      assert.equal(defaultPlaintextEnabled, newPlaintextEnabled);

      // 创建新小群验证使用新默认值
      const createTx = await community.write.createRoom({ account: user1.account });
      const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTx });
      const roomLogs = await publicClient.getContractEvents({
        address: community.address,
        abi: community.abi,
        eventName: "RoomCreated",
        fromBlock: createReceipt.blockNumber,
        toBlock: createReceipt.blockNumber,
      });

      const roomAddress = (roomLogs[0] as any).args.room as Address;
      const room = await viem.getContractAt("Room", roomAddress);

      const roomInviteFee = await room.read.inviteFee();
      const roomPlaintextEnabled = await room.read.plaintextEnabled();
      assert.equal(roomInviteFee, newInviteFee);
      assert.equal(roomPlaintextEnabled, newPlaintextEnabled);
    });

    it("只有大群群主可以设置默认参数", async function () {
      await assert.rejects(
        async () => {
          await community.write.setDefaultRoomParams(
            [parseEther("5"), false],
            { account: user1.account }
          );
        },
        /OwnableUnauthorizedAccount/
      );
    });
  });

  describe("大群内置消息", () => {
    let tree: MerkleTree;
    let whitelist: MerkleLeaf[];

    beforeEach(async () => {
      // 设置并加入大群
      const epoch = 1n;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
      const nonce = `0x${Date.now().toString(16).padStart(64, '0')}` as `0x${string}`;

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
    });

    it("应该能发送大群消息", async function () {
      const content = "Hello from community!";
      const cid = "QmMessageCid";
      const kind = 0; // 明文

      const tx = await community.write.sendCommunityMessage(
        [kind, content, cid],
        { account: user1.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const logs = await publicClient.getContractEvents({
        address: community.address,
        abi: community.abi,
        eventName: "CommunityMessageBroadcasted",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(logs.length, 1);
      assert.equal((logs[0] as any).args.sender?.toLowerCase(), user1.account.address.toLowerCase());
      assert.equal((logs[0] as any).args.kind, kind);
      assert.equal((logs[0] as any).args.seq, 1n);
      assert.equal((logs[0] as any).args.cid, cid);

      // 验证状态
      const count = await community.read.communityMessageCount();
      assert.equal(count, 1n);

      const [sender, ts, msgKind, msgContent, msgCid] = await community.read.getCommunityMessage([0n]);
      assert.equal(sender.toLowerCase(), user1.account.address.toLowerCase());
      assert.equal(msgKind, kind);
      assert.equal(msgContent, content);
      assert.equal(msgCid, cid);
    });

    it("应该能分页获取消息", async function () {
      // 发送多条消息
      for (let i = 0; i < 5; i++) {
        await community.write.sendCommunityMessage(
          [0, `Message ${i}`, `QmCid${i}`],
          { account: user1.account }
        );
      }

      // 获取前 3 条
      const messages = await community.read.getCommunityMessages([0n, 3n]);
      assert.equal(messages.length, 3);
      assert.equal(messages[0].content, "Message 0");
      assert.equal(messages[2].content, "Message 2");
    });

    it("非活跃成员不能发送消息", async function () {
      await assert.rejects(
        async () => {
          await community.write.sendCommunityMessage(
            [0, "test", ""],
            { account: user2.account }
          );
        },
        /NotActiveMember/
      );
    });

    it("群主应该能禁用明文消息", async function () {
      await community.write.setCommunityPlaintextEnabled(
        [false],
        { account: communityOwner.account }
      );

      await assert.rejects(
        async () => {
          await community.write.sendCommunityMessage(
            [0, "plaintext", ""],
            { account: user1.account }
          );
        },
        /PlaintextOff/
      );

      // 密文应该仍然可以发送
      await community.write.sendCommunityMessage(
        [1, "encrypted", ""],
        { account: user1.account }
      );
    });

    it("应该能分别获取明文和密文消息", async function () {
      // 发送混合消息：明文、密文、明文、密文、明文
      await community.write.sendCommunityMessage(
        [0, "Plaintext 1", ""],
        { account: user1.account }
      );
      await community.write.sendCommunityMessage(
        [1, "Encrypted 1", ""],
        { account: user1.account }
      );
      await community.write.sendCommunityMessage(
        [0, "Plaintext 2", ""],
        { account: user1.account }
      );
      await community.write.sendCommunityMessage(
        [1, "Encrypted 2", ""],
        { account: user1.account }
      );
      await community.write.sendCommunityMessage(
        [0, "Plaintext 3", ""],
        { account: user1.account }
      );

      // 获取所有明文消息
      const plaintextMessages = await community.read.getPlaintextMessages([0n, 10n]);
      assert.equal(plaintextMessages.length, 3);
      assert.equal(plaintextMessages[0].content, "Plaintext 1");
      assert.equal(plaintextMessages[0].kind, 0);
      assert.equal(plaintextMessages[1].content, "Plaintext 2");
      assert.equal(plaintextMessages[2].content, "Plaintext 3");

      // 获取所有密文消息
      const encryptedMessages = await community.read.getEncryptedMessages([0n, 10n]);
      assert.equal(encryptedMessages.length, 2);
      assert.equal(encryptedMessages[0].content, "Encrypted 1");
      assert.equal(encryptedMessages[0].kind, 1);
      assert.equal(encryptedMessages[1].content, "Encrypted 2");
    });

    it("应该能分页获取明文消息", async function () {
      // 发送多条混合消息
      for (let i = 0; i < 10; i++) {
        await community.write.sendCommunityMessage(
          [i % 2, `Message ${i}`, ""],
          { account: user1.account }
        );
      }

      // 获取前 5 条中的明文（索引 0, 2, 4）
      const plaintextMessages = await community.read.getPlaintextMessages([0n, 5n]);
      assert.equal(plaintextMessages.length, 3);
      assert.equal(plaintextMessages[0].content, "Message 0");
      assert.equal(plaintextMessages[1].content, "Message 2");
      assert.equal(plaintextMessages[2].content, "Message 4");
    });

    it("应该能分页获取密文消息", async function () {
      // 发送多条混合消息
      for (let i = 0; i < 10; i++) {
        await community.write.sendCommunityMessage(
          [i % 2, `Message ${i}`, ""],
          { account: user1.account }
        );
      }

      // 获取前 5 条中的密文（索引 1, 3）
      const encryptedMessages = await community.read.getEncryptedMessages([0n, 5n]);
      assert.equal(encryptedMessages.length, 2);
      assert.equal(encryptedMessages[0].content, "Message 1");
      assert.equal(encryptedMessages[1].content, "Message 3");
    });

    it("空消息数组应该返回空数组", async function () {
      const plaintextMessages = await community.read.getPlaintextMessages([0n, 10n]);
      assert.equal(plaintextMessages.length, 0);

      const encryptedMessages = await community.read.getEncryptedMessages([0n, 10n]);
      assert.equal(encryptedMessages.length, 0);
    });
  });

  describe("RSA 群聊公钥", () => {
    it("应该能设置 RSA 公钥", async function () {
      const publicKey = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq...\n-----END PUBLIC KEY-----";
      const metadataHash = keccak256(encodePacked(["string"], ["metadata"]));

      const tx = await community.write.setRsaGroupPublicKey(
        [publicKey, metadataHash],
        { account: communityOwner.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

      // 检查事件
      const keyLogs = await publicClient.getContractEvents({
        address: community.address,
        abi: community.abi,
        eventName: "RsaGroupPublicKeyUpdated",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(keyLogs.length, 1);
      assert.equal((keyLogs[0] as any).args.epoch, 1n);
      assert.equal((keyLogs[0] as any).args.rsaPublicKey, publicKey);

      const epochLogs = await publicClient.getContractEvents({
        address: community.address,
        abi: community.abi,
        eventName: "GroupKeyEpochIncreased",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(epochLogs.length, 1);
      assert.equal((epochLogs[0] as any).args.epoch, 1n);

      // 验证状态
      const storedKey = await community.read.getRsaGroupPublicKey();
      const epoch = await community.read.getGroupKeyEpoch();
      assert.equal(storedKey, publicKey);
      assert.equal(epoch, 1n);
    });

    it("只有群主可以设置 RSA 公钥", async function () {
      await assert.rejects(
        async () => {
          await community.write.setRsaGroupPublicKey(
            ["fake key", keccak256(encodePacked(["string"], ["test"]))],
            { account: user1.account }
          );
        },
        /OwnableUnauthorizedAccount/
      );
    });

    it("应该能多次更新公钥并递增 epoch", async function () {
      const key1 = "key1";
      const key2 = "key2";
      const hash = keccak256(encodePacked(["string"], ["test"]));

      await community.write.setRsaGroupPublicKey([key1, hash], { account: communityOwner.account });
      let epoch = await community.read.getGroupKeyEpoch();
      assert.equal(epoch, 1n);

      await community.write.setRsaGroupPublicKey([key2, hash], { account: communityOwner.account });
      epoch = await community.read.getGroupKeyEpoch();
      assert.equal(epoch, 2n);

      const storedKey = await community.read.getRsaGroupPublicKey();
      assert.equal(storedKey, key2);
    });
  });

  describe("元数据", () => {
    it("应该正确初始化元数据", async function () {
      const topicToken = await community.read.topicToken();
      const maxTier = await community.read.maxTier();
      const name = await community.read.name_();
      const avatarCid = await community.read.avatarCid();

      assert.equal(topicToken.toLowerCase(), unichat.address.toLowerCase());
      assert.equal(maxTier, 3);
      assert.equal(name, "测试大群");
      assert.equal(avatarCid, "QmTestAvatar");
    });
  });

  describe("成员查询", () => {
    let tree: MerkleTree;
    let whitelist: MerkleLeaf[];
    let epoch: bigint;

    beforeEach(async () => {
      // 设置并加入大群
      epoch = 1n;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
      
      // 为每个用户生成唯一的 nonce
      const nonce1 = `0x${Date.now().toString(16).padStart(64, '0')}` as `0x${string}`;
      const nonce2 = `0x${(Date.now() + 1).toString(16).padStart(64, '0')}` as `0x${string}`;
      const nonce3 = `0x${(Date.now() + 2).toString(16).padStart(64, '0')}` as `0x${string}`;

      whitelist = [
        {
          community: community.address,
          epoch,
          account: user1.account.address,
          maxTier: 3n,
          validUntil,
          nonce: nonce1,
        },
        {
          community: community.address,
          epoch,
          account: user2.account.address,
          maxTier: 2n,
          validUntil,
          nonce: nonce2,
        },
        {
          community: community.address,
          epoch,
          account: user3.account.address,
          maxTier: 1n,
          validUntil,
          nonce: nonce3,
        },
      ];

      const leaves = whitelist.map(computeLeaf);
      tree = new MerkleTree(leaves);
      const root = tree.getRoot();

      await community.write.setMerkleRoot(
        [root, "ipfs://whitelist"],
        { account: communityOwner.account }
      );
    });

    it("应该能获取成员总数", async function () {
      // 初始时应该为 0
      let count = await community.read.getMembersCount();
      assert.equal(count, 0n);

      // user1 加入
      const leaf1 = whitelist[0];
      const proof1 = tree.getProof(computeLeaf(leaf1));
      await community.write.joinCommunity(
        [leaf1.maxTier, leaf1.epoch, leaf1.validUntil, leaf1.nonce, proof1],
        { account: user1.account }
      );

      count = await community.read.getMembersCount();
      assert.equal(count, 1n);

      // user2 加入
      const leaf2 = whitelist[1];
      const proof2 = tree.getProof(computeLeaf(leaf2));
      await community.write.joinCommunity(
        [leaf2.maxTier, leaf2.epoch, leaf2.validUntil, leaf2.nonce, proof2],
        { account: user2.account }
      );

      count = await community.read.getMembersCount();
      assert.equal(count, 2n);

      // user3 加入
      const leaf3 = whitelist[2];
      const proof3 = tree.getProof(computeLeaf(leaf3));
      await community.write.joinCommunity(
        [leaf3.maxTier, leaf3.epoch, leaf3.validUntil, leaf3.nonce, proof3],
        { account: user3.account }
      );

      count = await community.read.getMembersCount();
      assert.equal(count, 3n);
    });

    it("应该能分页获取成员列表", async function () {
      // 所有用户加入
      for (const leaf of whitelist) {
        const proof = tree.getProof(computeLeaf(leaf));
        const account = leaf.account === user1.account.address ? user1.account :
                       leaf.account === user2.account.address ? user2.account : user3.account;
        await community.write.joinCommunity(
          [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, proof],
          { account }
        );
      }

      // 获取所有成员
      const allMembers = await community.read.getMembers([0n, 10n]);
      assert.equal(allMembers.length, 3);
      // 使用小写比较地址（合约返回的地址可能是小写的）
      const memberAddresses = allMembers.map((addr: Address) => addr.toLowerCase());
      assert.equal(memberAddresses.includes(user1.account.address.toLowerCase()), true);
      assert.equal(memberAddresses.includes(user2.account.address.toLowerCase()), true);
      assert.equal(memberAddresses.includes(user3.account.address.toLowerCase()), true);

      // 分页获取：第一页
      const page1 = await community.read.getMembers([0n, 2n]);
      assert.equal(page1.length, 2);

      // 分页获取：第二页
      const page2 = await community.read.getMembers([2n, 2n]);
      assert.equal(page2.length, 1);
      assert.equal(page2[0].toLowerCase(), allMembers[2].toLowerCase());
    });

    it("应该能获取当前活跃成员总数", async function () {
      // user1 和 user2 加入
      const leaf1 = whitelist[0];
      const proof1 = tree.getProof(computeLeaf(leaf1));
      await community.write.joinCommunity(
        [leaf1.maxTier, leaf1.epoch, leaf1.validUntil, leaf1.nonce, proof1],
        { account: user1.account }
      );

      const leaf2 = whitelist[1];
      const proof2 = tree.getProof(computeLeaf(leaf2));
      await community.write.joinCommunity(
        [leaf2.maxTier, leaf2.epoch, leaf2.validUntil, leaf2.nonce, proof2],
        { account: user2.account }
      );

      // 当前 epoch 应该有 2 个活跃成员
      let activeCount = await community.read.getActiveMembersCount();
      assert.equal(activeCount, 2n);

      // 更新 epoch（新白名单只包含 user1）
      const currentEpoch = await community.read.currentEpoch();
      const nextEpoch = currentEpoch + 1n;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
      const newNonce1 = `0x${(Date.now() + 100).toString(16).padStart(64, '0')}` as `0x${string}`;

      const newWhitelist: MerkleLeaf[] = [
        {
          community: community.address,
          epoch: nextEpoch,
          account: user1.account.address,
          maxTier: 3n,
          validUntil,
          nonce: newNonce1,
        },
      ];

      const newLeaves = newWhitelist.map(computeLeaf);
      const newTree = new MerkleTree(newLeaves);
      const newRoot = newTree.getRoot();

      await community.write.setMerkleRoot(
        [newRoot, "ipfs://new-whitelist"],
        { account: communityOwner.account }
      );

      // user1 重新加入新 epoch
      const newLeaf1 = newWhitelist[0];
      const newProof1 = newTree.getProof(computeLeaf(newLeaf1));
      await community.write.joinCommunity(
        [newLeaf1.maxTier, newLeaf1.epoch, newLeaf1.validUntil, newLeaf1.nonce, newProof1],
        { account: user1.account }
      );

      // 现在只有 user1 是活跃成员（user2 不在新 epoch 中）
      activeCount = await community.read.getActiveMembersCount();
      assert.equal(activeCount, 1n);

      // 但总成员数仍然是 2（包含历史成员 user2）
      const totalCount = await community.read.getMembersCount();
      assert.equal(totalCount, 2n);
    });

    it("应该能分页获取当前活跃成员列表", async function () {
      // 所有用户加入 epoch 1
      for (const leaf of whitelist) {
        const proof = tree.getProof(computeLeaf(leaf));
        const account = leaf.account === user1.account.address ? user1.account :
                       leaf.account === user2.account.address ? user2.account : user3.account;
        await community.write.joinCommunity(
          [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, proof],
          { account }
        );
      }

      // 获取所有活跃成员（应该是 3 个）
      const activeMembers = await community.read.getActiveMembers([0n, 10n]);
      assert.equal(activeMembers.length, 3);
      // 使用小写比较地址（合约返回的地址可能是小写的）
      const activeAddresses = activeMembers.map((addr: Address) => addr.toLowerCase());
      assert.equal(activeAddresses.includes(user1.account.address.toLowerCase()), true);
      assert.equal(activeAddresses.includes(user2.account.address.toLowerCase()), true);
      assert.equal(activeAddresses.includes(user3.account.address.toLowerCase()), true);

      // 更新 epoch（新白名单只包含 user1 和 user3）
      const currentEpoch = await community.read.currentEpoch();
      const nextEpoch = currentEpoch + 1n;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
      const newNonce1 = `0x${(Date.now() + 100).toString(16).padStart(64, '0')}` as `0x${string}`;
      const newNonce3 = `0x${(Date.now() + 101).toString(16).padStart(64, '0')}` as `0x${string}`;

      const newWhitelist: MerkleLeaf[] = [
        {
          community: community.address,
          epoch: nextEpoch,
          account: user1.account.address,
          maxTier: 3n,
          validUntil,
          nonce: newNonce1,
        },
        {
          community: community.address,
          epoch: nextEpoch,
          account: user3.account.address,
          maxTier: 1n,
          validUntil,
          nonce: newNonce3,
        },
      ];

      const newLeaves = newWhitelist.map(computeLeaf);
      const newTree = new MerkleTree(newLeaves);
      const newRoot = newTree.getRoot();

      await community.write.setMerkleRoot(
        [newRoot, "ipfs://new-whitelist"],
        { account: communityOwner.account }
      );

      // user1 和 user3 重新加入新 epoch
      for (const leaf of newWhitelist) {
        const proof = newTree.getProof(computeLeaf(leaf));
        const account = leaf.account === user1.account.address ? user1.account : user3.account;
        await community.write.joinCommunity(
          [leaf.maxTier, leaf.epoch, leaf.validUntil, leaf.nonce, proof],
          { account }
        );
      }

      // 现在只有 user1 和 user3 是活跃成员
      const newActiveMembers = await community.read.getActiveMembers([0n, 10n]);
      assert.equal(newActiveMembers.length, 2);
      // 使用小写比较地址
      const newActiveAddresses = newActiveMembers.map((addr: Address) => addr.toLowerCase());
      assert.equal(newActiveAddresses.includes(user1.account.address.toLowerCase()), true);
      assert.equal(newActiveAddresses.includes(user3.account.address.toLowerCase()), true);
      assert.equal(newActiveAddresses.includes(user2.account.address.toLowerCase()), false);

      // 但所有历史成员仍然在总列表中
      const allMembers = await community.read.getMembers([0n, 10n]);
      assert.equal(allMembers.length, 3);
    });

    it("空成员列表应该返回 0 和空数组", async function () {
      const count = await community.read.getMembersCount();
      assert.equal(count, 0n);

      const activeCount = await community.read.getActiveMembersCount();
      assert.equal(activeCount, 0n);

      const members = await community.read.getMembers([0n, 10n]);
      assert.equal(members.length, 0);

      const activeMembers = await community.read.getActiveMembers([0n, 10n]);
      assert.equal(activeMembers.length, 0);
    });

    it("分页超出范围应该返回空数组", async function () {
      // user1 加入
      const leaf1 = whitelist[0];
      const proof1 = tree.getProof(computeLeaf(leaf1));
      await community.write.joinCommunity(
        [leaf1.maxTier, leaf1.epoch, leaf1.validUntil, leaf1.nonce, proof1],
        { account: user1.account }
      );

      // 超出范围的查询应该返回空数组
      const members = await community.read.getMembers([10n, 5n]);
      assert.equal(members.length, 0);

      const activeMembers = await community.read.getActiveMembers([10n, 5n]);
      assert.equal(activeMembers.length, 0);
    });

    it("同一用户重新加入不应该重复计数", async function () {
      // user1 第一次加入
      const leaf1 = whitelist[0];
      const proof1 = tree.getProof(computeLeaf(leaf1));
      await community.write.joinCommunity(
        [leaf1.maxTier, leaf1.epoch, leaf1.validUntil, leaf1.nonce, proof1],
        { account: user1.account }
      );

      let count = await community.read.getMembersCount();
      assert.equal(count, 1n);

      // 更新 epoch，user1 重新加入
      const currentEpoch = await community.read.currentEpoch();
      const nextEpoch = currentEpoch + 1n;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30);
      const newNonce1 = `0x${(Date.now() + 100).toString(16).padStart(64, '0')}` as `0x${string}`;

      const newWhitelist: MerkleLeaf[] = [
        {
          community: community.address,
          epoch: nextEpoch,
          account: user1.account.address,
          maxTier: 3n,
          validUntil,
          nonce: newNonce1,
        },
      ];

      const newLeaves = newWhitelist.map(computeLeaf);
      const newTree = new MerkleTree(newLeaves);
      const newRoot = newTree.getRoot();

      await community.write.setMerkleRoot(
        [newRoot, "ipfs://new-whitelist"],
        { account: communityOwner.account }
      );

      const newLeaf1 = newWhitelist[0];
      const newProof1 = newTree.getProof(computeLeaf(newLeaf1));
      await community.write.joinCommunity(
        [newLeaf1.maxTier, newLeaf1.epoch, newLeaf1.validUntil, newLeaf1.nonce, newProof1],
        { account: user1.account }
      );

      // 总成员数应该仍然是 1（不重复计数）
      count = await community.read.getMembersCount();
      assert.equal(count, 1n);

      // 成员列表应该只包含 user1 一次
      const members = await community.read.getMembers([0n, 10n]);
      assert.equal(members.length, 1);
      assert.equal(members[0].toLowerCase(), user1.account.address.toLowerCase());
    });
  });
});

