import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { network } from "hardhat";
import { parseEther, type Address } from "viem";

describe("CommunityFactory", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  let unichat: any;
  let communityImpl: any;
  let roomImpl: any;
  let factory: any;
  let deployer: any;
  let treasury: any;
  let communityOwner: any;

  beforeEach(async () => {
    const clients = await viem.getWalletClients();
    [deployer, treasury, communityOwner] = clients;

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
  });

  it("应该正确初始化 Factory", async function () {
    const unichatAddr = await factory.read.UNICHAT();
    const treasuryAddr = await factory.read.treasury();
    const roomFee = await factory.read.roomCreateFee();
    const commImpl = await factory.read.communityImplementation();
    const rImpl = await factory.read.roomImplementation();

    assert.equal(unichatAddr.toLowerCase(), unichat.address.toLowerCase());
    assert.equal(treasuryAddr.toLowerCase(), treasury.account.address.toLowerCase());
    assert.equal(roomFee, parseEther("50"));
    assert.equal(commImpl.toLowerCase(), communityImpl.address.toLowerCase());
    assert.equal(rImpl.toLowerCase(), roomImpl.address.toLowerCase());
  });

  it("应该能创建新的 Community", async function () {
    const tx = await factory.write.createCommunity([communityOwner.account.address]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

    // 检查事件
    const logs = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "CommunityCreated",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });

    assert.equal(logs.length, 1);
    assert.equal((logs[0] as any).args.owner?.toLowerCase(), communityOwner.account.address.toLowerCase());

    const communityAddress = (logs[0] as any).args.community as Address;
    assert.notEqual(communityAddress, "0x0000000000000000000000000000000000000000");

    // 验证 Community 合约已正确初始化
    const community = await viem.getContractAt("Community", communityAddress);
    const owner = await community.read.owner();
    assert.equal(owner.toLowerCase(), communityOwner.account.address.toLowerCase());
  });

  it("只有 owner 可以创建 Community", async function () {
    await assert.rejects(
      async () => {
        await factory.write.createCommunity(
          [communityOwner.account.address],
          { account: communityOwner.account }
        );
      },
      /OwnableUnauthorizedAccount/
    );
  });

  it("应该能更新实现合约地址", async function () {
    const newCommunityImpl = await viem.deployContract("Community");
    const newRoomImpl = await viem.deployContract("Room");

    const tx = await factory.write.setImplementations([
      newCommunityImpl.address,
      newRoomImpl.address,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: tx });

    const commImpl = await factory.read.communityImplementation();
    const rImpl = await factory.read.roomImplementation();

    assert.equal(commImpl.toLowerCase(), newCommunityImpl.address.toLowerCase());
    assert.equal(rImpl.toLowerCase(), newRoomImpl.address.toLowerCase());
  });

  it("应该能更新创建费", async function () {
    const newFee = parseEther("100");
    const tx = await factory.write.setRoomCreateFee([newFee]);
    await publicClient.waitForTransactionReceipt({ hash: tx });

    const roomFee = await factory.read.roomCreateFee();
    assert.equal(roomFee, newFee);
  });

  it("应该能更新金库地址", async function () {
    const [, , , newTreasury] = await viem.getWalletClients();
    const tx = await factory.write.setTreasury([newTreasury.account.address]);
    await publicClient.waitForTransactionReceipt({ hash: tx });

    const treasuryAddr = await factory.read.treasury();
    assert.equal(treasuryAddr.toLowerCase(), newTreasury.account.address.toLowerCase());
  });

  it("不应该接受零地址作为金库", async function () {
    await assert.rejects(
      async () => {
        await factory.write.setTreasury(["0x0000000000000000000000000000000000000000"]);
      },
      /ZeroAddr/
    );
  });
});

