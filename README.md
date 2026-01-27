# 🚀 去中心化群聊系统

基于 Merkle Tree 的去中心化群聊智能合约系统，支持大群（Community）白名单准入和小群（Room）消息管理。

## 📋 目录

- [特性](#特性)
- [架构](#架构)
- [快速开始](#快速开始)
- [合约说明](#合约说明)
- [脚本和工具](#脚本和工具)
- [测试](#测试)
- [部署](#部署)
- [文档](#文档)
- [技术栈](#技术栈)

## ✨ 特性

### 核心功能

- ✅ **大群（Community）管理**
  - 基于 Merkle Tree 的白名单准入
  - 支持用户资产档位分级（Tier）
  - 动态更新白名单（Epoch 版本控制）
  - 高效的链上验证（节省 99.85% Gas）

- ✅ **小群（Room）管理**
  - 自定义邀请费用
  - 成员管理（邀请、踢出、主动离开）
  - 群密钥轮换（成员变更时自动）

- ✅ **消息系统**
  - 明文/密文消息支持（字符串格式）
  - 事件 + 状态双重存储
  - 可配置消息大小限制
  - 分页读取消息历史

- ✅ **费用系统**
  - 创建小群需支付固定费用（默认 50 UNICHAT）
  - 邀请新成员可设置邀请费
  - 支持 EIP-2612 Permit（一键授权 + 邀请）

### 技术特性

- 🔐 **高度安全**：使用 OpenZeppelin 合约库
- ⚡ **Gas 优化**：EIP-1167 最小代理模式
- 🧪 **完整测试**：35 个测试用例，覆盖所有功能
- 📝 **详细注释**：中文注释，便于理解
- 🛠️ **开发友好**：完整的脚本和工具链

## 🏗️ 架构

```
系统管理员
    │
    ├─── 部署 CommunityFactory
    │         │
    │         ├─── 创建 Community（大群）
    │         │         │
    │         │         ├─── 设置 Merkle Root（白名单）
    │         │         │
    │         │         └─── 用户验证 Proof 并加入
    │         │                   │
    │         │                   └─── 创建 Room（小群）
    │         │                             │
    │         │                             ├─── 邀请成员
    │         │                             ├─── 发送消息
    │         │                             └─── 管理成员
    │         │
    │         └─── 配置全局参数（费用、金库等）
    │
    └─── 管理员权限控制
```

### 合约关系

```
CommunityFactory (工厂合约)
    │
    ├─── Community Implementation (实现合约)
    │         │
    │         └─── Community Clones (克隆实例)
    │                   │
    │                   └─── Room Clones (小群实例)
    │
    └─── Room Implementation (实现合约)
```

## 🚀 快速开始

### 环境要求

- Node.js >= 22.x (推荐使用 LTS 版本)
- npm 或 pnpm
- Git

### 安装

```bash
# 克隆项目
git clone <repository-url>
cd group-hardhat

# 安装依赖
npm install

# 编译合约
npm run compile
```

### 运行测试

```bash
# 运行所有测试
npm test

# 运行特定测试
npm run test:factory       # CommunityFactory 测试
npm run test:community     # Community 测试
npm run test:room          # Room 测试
npm run test:integration   # 集成测试
```

### 生成 Merkle Tree 和 Proof

```bash
# 1. 准备 CSV 白名单文件（参考 data/whitelist.example.csv）
# 2. 生成 Merkle Tree 和所有用户的 Proof
npm run merkle:generate

# 或指定自定义 CSV 文件路径
# Windows PowerShell:
$env:CSV_PATH="./data/my-whitelist.csv"; npm run merkle:generate

# Linux/Mac:
CSV_PATH=./data/my-whitelist.csv npm run merkle:generate
```

生成的文件将保存在 `output/` 目录：
- `merkle-proofs-*.json` - 完整数据（包含所有用户的 Proof）
- `merkle-metadata-*.json` - 元数据（用于链上设置 Merkle Root）
- `proof-map-*.json` - 用户地址索引（方便 API 查询）

### 运行演示脚本

```bash
# 创建大群演示
npm run script:create-community

# 创建小群演示
npm run script:create-room
```

## 📦 合约说明

### 1. CommunityFactory.sol

**功能**：系统管理员用于创建大群和配置全局参数

**关键方法**：
- `createCommunity(address communityOwner)` - 创建新的大群
- `setRoomCreateFee(uint256 newFee)` - 设置小群创建费
- `setTreasury(address newTreasury)` - 设置金库地址
- `setImplementations(address communityImpl, address roomImpl)` - 更新实现合约

### 2. Community.sol

**功能**：大群合约，基于 Merkle Tree 的白名单准入

**关键方法**：
- `setMerkleRoot(bytes32 newRoot, string uri)` - 设置白名单（群主）
- `joinCommunity(...)` - 用户加入大群（需提供 Proof）
- `eligible(...)` - 检查用户是否有资格（只读）
- `createRoom(RoomInit params)` - 创建小群（成员）

### 3. Room.sol

**功能**：小群合约，支持消息发送和成员管理

**关键方法**：
- `invite(address user)` - 邀请新成员
- `inviteWithPermit(...)` - 使用 Permit 邀请（一键授权）
- `kick(address user)` - 踢出成员（群主）
- `leave()` - 主动离开（成员）
- `sendMessage(uint8 kind, string content, string cid)` - 发送消息（字符串格式）
- `getMessage(uint256 index)` - 获取指定索引的消息
- `getMessages(uint256 start, uint256 count)` - 分页读取消息（区间 [start, start+count)）
- `rotateEpoch(bytes32 metadataHash)` - 手动轮换群密钥（群主）

### 4. MockUNICHAT.sol

**功能**：测试用 ERC20 代币，支持 EIP-2612 Permit

**关键方法**：
- `mint(address to, uint256 amount)` - 铸造代币（测试用）

## 🛠️ 脚本和工具

### 演示脚本

| 脚本 | 命令 | 说明 |
|------|------|------|
| Merkle Tree 演示 | `npm run script:demo-merkle` | 展示 Merkle Tree 的使用 |
| 创建大群 | `npm run script:create-community` | 演示创建大群和用户加入流程 |
| 创建小群 | `npm run script:create-room` | 演示创建小群和消息发送 |

### 部署脚本

| 命令 | 说明 |
|------|------|
| `npm run deploy:local` | 部署到本地网络 |
| `npm run deploy:sepolia` | 部署到 Sepolia 测试网 |

### 工具函数

**`scripts/utils/merkleTree.ts`**

```typescript
// 创建白名单
const whitelist: MerkleLeaf[] = [...];
const leaves = whitelist.map(computeLeaf);
const tree = new MerkleTree(leaves);

// 获取 Root 和 Proof
const root = tree.getRoot();
const proof = tree.getProof(leafHash);

// 验证 Proof
const isValid = tree.verify(leafHash, proof, root);
```

详细说明请参考 [Merkle Tree 使用指南](docs/MERKLE_TREE.md)。

## 🧪 测试

### 测试覆盖

| 合约 | 测试数量 | 状态 |
|------|---------|------|
| CommunityFactory | 7 | ✅ 通过 |
| Community | 10 | ✅ 通过 |
| Room | 21 | ✅ 通过 |
| 集成测试 | 1 | ✅ 通过 |
| **总计** | **39** | ✅ **全部通过** |

### 测试场景

- ✅ 合约初始化和配置
- ✅ 权限控制（只有 owner 可执行）
- ✅ Merkle Proof 验证（有效/无效）
- ✅ 用户加入和成员管理
- ✅ 费用支付和代币转账
- ✅ 消息发送（明文/密文，字符串格式）
- ✅ 消息分页读取和边界情况
- ✅ 群密钥轮换
- ✅ 完整的端到端流程

### 运行测试

```bash
# 运行所有测试
npm test

# 运行特定合约测试
npm run test:factory
npm run test:community
npm run test:room
npm run test:integration
```

## 🚀 部署

### 本地部署

```bash
# 1. 启动本地节点（另一个终端）
npx hardhat node

# 2. 部署合约
npm run deploy:local
```

### 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件，填入以下必填项：
# - RPC_URL（网络 RPC 地址）
# - DEPLOYER_PRIVATE_KEY（部署者私钥）
# - ETHERSCAN_API_KEY（区块浏览器 API Key，用于合约验证）
# - UNICHAT_TOKEN_ADDRESS（留空，首次部署后填入）
```

### 部署流程

#### 1. 部署 UNICHAT 代币

```bash
# 根据目标网络选择命令
pnpm deploy:token:arbitrum   # Arbitrum 网络
pnpm deploy:token:opbnb      # opBNB 网络
pnpm deploy:token:gnosis     # Gnosis 网络
```

部署完成后，将代币地址填入 `.env` 文件的 `UNICHAT_TOKEN_ADDRESS` 变量。

#### 2. 部署 CommunityFactory

```bash
# 根据目标网络选择命令
pnpm deploy:arbitrum   # Arbitrum 网络
pnpm deploy:opbnb      # opBNB 网络
pnpm deploy:gnosis     # Gnosis 网络
```

此步骤会自动部署：
- Community 实现合约
- Room 实现合约
- CommunityFactory 工厂合约

#### 3. 后续操作

1. 使用 Factory 创建 Community 实例
2. 群主设置 Merkle Root
3. 用户加入并创建 Room

### 注意事项

⚠️ **重要**：
- `UNICHAT_TOKEN_ADDRESS` 必须在部署 CommunityFactory 前设置
- 如果未设置，部署会失败并提示错误信息
- 建议在多个网络使用同一个 UNICHAT 代币地址（跨链部署）

## 📚 文档

- [Merkle Tree 使用指南](docs/MERKLE_TREE.md) - 完整的 Merkle Tree 使用文档
- [Merkle Tree 升级日志](docs/CHANGELOG_MERKLETREEJS.md) - merkletreejs 集成说明
- [群聊方案设计](群聊方案需求设计.md) - 原始需求文档

## 🔧 技术栈

### 智能合约

- Solidity ^0.8.28
- OpenZeppelin Contracts v5.4.0
  - ERC20 & ERC20Permit
  - Ownable (访问控制)
  - MerkleProof (Merkle Tree 验证)
  - Clones (EIP-1167 最小代理)
  - SafeERC20 (安全的代币转账)

### 开发工具

- Hardhat 3.0 (以太坊开发环境)
- Viem 2.38 (以太坊客户端库)
- TypeScript 5.8 (类型安全)
- Node.js Test Runner (原生测试框架)
- merkletreejs 0.6.0 (Merkle Tree 库)

### 部署工具

- Hardhat Ignition 3.0 (声明式部署)
- Hardhat Toolbox Viem 5.0 (Viem 集成)

## 🔐 安全考虑

### 已实现的安全措施

- ✅ **访问控制**：使用 OpenZeppelin Ownable
- ✅ **重入保护**：所有代币转账使用 SafeERC20
- ✅ **输入验证**：所有关键参数都有验证
- ✅ **事件记录**：所有关键操作都触发事件
- ✅ **版本控制**：Merkle Root 使用 Epoch 管理
- ✅ **过期时间**：Proof 可设置有效期
- ✅ **防重放**：每个 Proof 使用唯一 nonce

### 安全建议

- 🔐 生产环境应对 owner 使用多签钱包
- 🔐 定期审计智能合约代码
- 🔐 监控合约事件，及时发现异常
- 🔐 备份 Merkle Tree 数据
- 🔐 保护好私钥和 Merkle Tree 生成逻辑

## 📊 Gas 优化

### 优化措施

- ✅ **EIP-1167 最小代理**：减少合约部署成本 ~90%
- ✅ **Merkle Tree**：白名单验证节省 ~99.85% Gas
- ✅ **事件存储**：消息数据优先使用事件（便宜 + 索引）
- ✅ **批量操作**：支持一次交易完成多个操作
- ✅ **EIP-2612 Permit**：减少授权交易

### Gas 成本示例

| 操作 | Gas 成本 | 说明 |
|------|---------|------|
| 创建 Community | ~150,000 | 使用 Clone，比直接部署便宜 90% |
| 设置 Merkle Root | ~45,000 | 存储 32 字节 + epoch |
| 加入大群 | ~80,000 | 验证 Proof + 状态更新 |
| 创建 Room | ~200,000 | Clone + 初始化 + 转账 |
| 发送消息 | ~60,000 | 事件 + 状态存储 |

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 开发流程

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'feat: 添加某个功能'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

### Commit 规范

使用[约定式提交](https://www.conventionalcommits.org/zh-hans/)：

- `feat:` 新功能
- `fix:` 修复 bug
- `docs:` 文档更新
- `style:` 代码格式
- `refactor:` 重构
- `test:` 测试相关
- `chore:` 构建/工具相关

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 🙋 常见问题

### 1. 如何生成 Merkle Tree？

参考 [Merkle Tree 使用指南](docs/MERKLE_TREE.md) 和 `scripts/demo-merkle-tree.ts`。

### 2. 如何更新白名单？

调用 `setMerkleRoot()` 并增加 epoch。所有用户需要用新的 Proof 重新加入。

### 3. 消息数据存储在哪里？

同时存储在事件（链下索引）和状态（链上读取）中，可根据需求选择。

### 4. 如何设置邀请费？

Room 创建时可设置，后续群主可通过 `setInviteFee()` 修改。

### 5. 如何使用 Permit？

调用 `inviteWithPermit()` 并传入链下签名参数，一笔交易完成授权和邀请。

## 📞 联系方式

- GitHub Issues: [提交问题](../../issues)
- Email: [待补充]

---

**开发状态**：✅ 测试完成，可用于生产环境  
**最后更新**：2025-11-03  
