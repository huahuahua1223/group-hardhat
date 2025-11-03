# 群聊智能合约系统

基于 Merkle Tree 的去中心化群聊系统智能合约，使用 Hardhat 3.0 和 Viem 开发。

## 📋 项目概述

本项目实现了一个完整的去中心化群聊系统，包含以下核心功能：

- **大群（Community）**：基于 Merkle Tree 的白名单准入机制
- **小群（Room）**：支持自定义邀请费用的小群聊天室
- **消息系统**：支持明文和密文消息，带状态存储和事件索引
- **经济模型**：创建费、邀请费等代币经济系统
- **成员管理**：邀请、踢出、主动离开等完整功能
- **密钥轮换**：支持群密钥 epoch 管理

## 🏗️ 架构设计

### 合约结构

```
CommunityFactory (工厂合约)
    ├── Community (大群，使用 EIP-1167 克隆)
    │   ├── Merkle Root 管理
    │   ├── 成员资格验证
    │   └── Room (小群，使用 EIP-1167 克隆)
    │       ├── 成员管理
    │       ├── 消息发送
    │       └── 密钥轮换
    └── MockUNICHAT (测试代币，支持 EIP-2612 Permit)
```

### 核心特性

1. **Merkle Tree 白名单**
   - 链下计算，链上验证
   - 支持资产档位（maxTier）
   - 支持过期时间（validUntil）
   - 防重放攻击（nonce）

2. **EIP-1167 最小代理**
   - 大幅降低部署成本
   - Community 和 Room 都使用克隆模式

3. **EIP-2612 Permit**
   - 支持一笔交易完成授权+扣费
   - 提升用户体验

4. **双重消息存储**
   - 事件（便宜、易索引）
   - 状态存储（可链上读取）

## 🚀 快速开始

### 环境要求

- Node.js >= 22.10.0 (LTS)
- npm 或 pnpm

### 安装依赖

```bash
npm install
# 或
pnpm install
```

### 编译合约

```bash
npm run compile
```

### 运行测试

```bash
# 运行所有测试
npm test

# 运行特定测试
npm run test:factory      # CommunityFactory 测试
npm run test:community    # Community 测试
npm run test:room         # Room 测试
npm run test:integration  # 集成测试
```

### 部署合约

```bash
# 部署到本地网络
npm run deploy:local

# 部署到 Sepolia 测试网
npm run deploy:sepolia
```

### 运行脚本

```bash
# 创建大群并设置 Merkle Root
npm run script:create-community

# 创建小群并演示功能
npm run script:create-room
```

## 📁 项目结构

```
group-hardhat/
├── contracts/              # 智能合约
│   ├── CommunityFactory.sol   # 工厂合约
│   ├── Community.sol           # 大群合约
│   ├── Room.sol                # 小群合约
│   └── MockUNICHAT.sol         # 测试代币
├── ignition/modules/       # Hardhat Ignition 部署模块
│   ├── MockToken.ts            # 代币部署
│   ├── Implementations.ts      # 实现合约部署
│   └── CommunityFactory.ts     # 工厂部署
├── scripts/                # 自定义脚本
│   ├── utils/
│   │   └── merkleTree.ts       # Merkle Tree 工具
│   ├── create-community.ts     # 创建大群脚本
│   └── create-room.ts          # 创建小群脚本
├── test/                   # 测试文件
│   ├── CommunityFactory.ts     # 工厂测试
│   ├── Community.ts            # 大群测试
│   ├── Room.ts                 # 小群测试
│   └── Integration.ts          # 集成测试
├── hardhat.config.ts       # Hardhat 配置
├── package.json            # 项目配置
└── README.md               # 项目文档
```

## 🧪 测试覆盖

项目包含 35 个测试用例，覆盖以下场景：

### CommunityFactory 测试
- ✅ 工厂初始化
- ✅ 创建 Community
- ✅ 权限控制
- ✅ 参数更新

### Community 测试
- ✅ Merkle Root 管理
- ✅ Merkle Proof 验证（链上/链下）
- ✅ 用户加入大群
- ✅ 创建小群
- ✅ 权限与错误处理

### Room 测试
- ✅ 基本配置管理
- ✅ 成员邀请
- ✅ 成员踢出/离开
- ✅ 明文消息发送
- ✅ 密文消息发送
- ✅ 消息历史读取
- ✅ 群密钥轮换
- ✅ 权限与限制

### 集成测试
- ✅ 完整流程：部署 → 创建大群 → 设置白名单 → 用户加入 → 创建小群 → 邀请成员 → 发送消息 → 成员离开

## 📖 使用流程

### 1. 部署合约

```typescript
// 部署 MockUNICHAT
const unichat = await viem.deployContract("MockUNICHAT");

// 部署实现合约
const communityImpl = await viem.deployContract("Community");
const roomImpl = await viem.deployContract("Room");

// 部署工厂
const factory = await viem.deployContract("CommunityFactory", [
  unichat.address,
  treasury,
  parseEther("50"), // 创建费
  communityImpl.address,
  roomImpl.address,
]);
```

### 2. 创建大群

```typescript
// 系统管理员创建大群
const tx = await factory.write.createCommunity([communityOwner]);
// 从事件中获取 community 地址
```

### 3. 设置白名单（链下）

```typescript
import { MerkleTree, computeLeaf } from "./scripts/utils/merkleTree";

// 创建白名单
const whitelist = [
  {
    community: communityAddress,
    epoch: 1n,
    account: userAddress,
    maxTier: 3n,
    validUntil: timestamp,
    nonce: "0x...",
  },
  // ... 更多用户
];

// 生成 Merkle Tree
const leaves = whitelist.map(computeLeaf);
const tree = new MerkleTree(leaves);
const root = tree.getRoot();

// 设置 root（链上）
await community.write.setMerkleRoot([root, "ipfs://metadata"]);
```

### 4. 用户加入大群

```typescript
// 获取 proof（链下）
const leaf = computeLeaf(userLeafData);
const proof = tree.getProof(leaf);

// 验证资格（可选，只读）
const eligible = await community.read.eligible([
  account,
  maxTier,
  epoch,
  validUntil,
  nonce,
  proof,
]);

// 加入大群（写状态）
await community.write.joinCommunity(
  [maxTier, epoch, validUntil, nonce, proof],
  { account: userAccount }
);
```

### 5. 创建小群

```typescript
// 授权创建费
await unichat.write.approve([community.address, parseEther("50")]);

// 创建小群
await community.write.createRoom([{
  inviteFee: parseEther("10"),
  plaintextEnabled: true,
  messageMaxBytes: 1024,
}]);
```

### 6. 邀请成员

```typescript
// 方式 1：普通邀请
await unichat.write.approve([room.address, inviteFee]);
await room.write.invite([userAddress]);

// 方式 2：使用 Permit（一笔交易）
await room.write.inviteWithPermit([
  userAddress,
  value,
  deadline,
  v, r, s
]);
```

### 7. 发送消息

```typescript
// 明文消息
await room.write.sendMessage([
  0, // kind: PLAINTEXT
  encodePacked(["string"], ["Hello, World!"]),
  "ipfs://cid" // 可选
]);

// 密文消息
await room.write.sendMessage([
  1, // kind: ENCRYPTED
  encryptedContent,
  "ipfs://encrypted-cid"
]);
```

### 8. 读取消息

```typescript
// 获取消息数量
const count = await room.read.messageCount();

// 读取单条消息
const message = await room.read.getMessage([index]);
// 返回: [sender, timestamp, kind, content, cid]

// 监听事件
const events = await publicClient.getContractEvents({
  address: room.address,
  abi: room.abi,
  eventName: "MessageBroadcasted",
});
```

## 🔐 安全特性

- ✅ OpenZeppelin 合约库（Ownable, AccessControl, MerkleProof）
- ✅ SafeERC20 防止代币转账失败
- ✅ Reentrancy 保护（使用 Checks-Effects-Interactions 模式）
- ✅ 零地址检查
- ✅ 权限控制（onlyOwner, onlyMember）
- ✅ Epoch 版本控制防止过期 proof
- ✅ Nonce 防重放攻击

## 📝 许可证

MIT

## 👥 贡献

欢迎提交 Issue 和 Pull Request！

## 📚 相关文档

- [Hardhat 3.0 文档](https://hardhat.org/docs/getting-started)
- [Viem 文档](https://viem.sh/)
- [OpenZeppelin 合约](https://docs.openzeppelin.com/contracts/)
- [EIP-1167: 最小代理](https://eips.ethereum.org/EIPS/eip-1167)
- [EIP-2612: Permit](https://eips.ethereum.org/EIPS/eip-2612)

## 🎯 测试结果

```
✔ 35 passing (9666ms)
```

所有测试通过！✨
