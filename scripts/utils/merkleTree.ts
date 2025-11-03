import { keccak256, encodePacked, type Address } from "viem";
import { MerkleTree as MerkleTreeJS } from "merkletreejs";

/**
 * Merkle Tree 叶子节点数据
 */
export interface MerkleLeaf {
  community: Address;
  epoch: bigint;
  account: Address;
  maxTier: bigint;
  validUntil: bigint;
  nonce: `0x${string}`;
}

/**
 * 计算叶子节点哈希
 */
export function computeLeaf(leaf: MerkleLeaf): `0x${string}` {
  return keccak256(
    encodePacked(
      ["address", "uint256", "address", "uint256", "uint256", "bytes32"],
      [leaf.community, leaf.epoch, leaf.account, leaf.maxTier, leaf.validUntil, leaf.nonce]
    )
  );
}

/**
 * Merkle Tree 包装类（基于 merkletreejs）
 * @description 使用 merkletreejs 库实现 Merkle Tree，支持标准的 Merkle Proof 生成和验证
 */
export class MerkleTree {
  private tree: MerkleTreeJS;
  private leaves: Buffer[];

  /**
   * 构造函数
   * @param leaves 叶子节点哈希数组
   */
  constructor(leaves: `0x${string}`[]) {
    // 将 hex 字符串转换为 Buffer
    this.leaves = leaves.map((leaf) => Buffer.from(leaf.slice(2), "hex"));
    
    // 创建 Merkle Tree
    // - hashLeaves: false，因为叶子已经是哈希值
    // - sortPairs: true，OpenZeppelin 的 MerkleProof 库要求排序
    // - sortLeaves: true，对叶子节点排序，确保树结构一致
    this.tree = new MerkleTreeJS(this.leaves, this.keccak256Hash, {
      hashLeaves: false,
      sortPairs: true,
      sortLeaves: true,
    });
  }

  /**
   * 自定义哈希函数（用于计算父节点）
   * @description 将两个子节点哈希组合后再哈希，兼容 Solidity 的 keccak256(abi.encodePacked(left, right))
   */
  private keccak256Hash(data: Buffer): Buffer {
    // merkletreejs 会自动将左右节点拼接后传入
    // 我们需要将 Buffer 转换为 hex 字符串，然后使用 viem 的 keccak256
    const hex = `0x${data.toString("hex")}` as `0x${string}`;
    const hash = keccak256(hex);
    return Buffer.from(hash.slice(2), "hex");
  }

  /**
   * 获取 Merkle Root
   */
  getRoot(): `0x${string}` {
    const root = this.tree.getRoot();
    return `0x${root.toString("hex")}` as `0x${string}`;
  }

  /**
   * 获取指定叶子节点的 Merkle Proof
   * @param leaf 叶子节点哈希
   * @returns Proof 数组（兄弟节点哈希）
   */
  getProof(leaf: `0x${string}`): `0x${string}`[] {
    const leafBuffer = Buffer.from(leaf.slice(2), "hex");
    const proof = this.tree.getProof(leafBuffer);
    
    // 转换为 hex 字符串数组
    return proof.map((p) => `0x${p.data.toString("hex")}` as `0x${string}`);
  }

  /**
   * 验证 Merkle Proof
   * @param leaf 叶子节点哈希
   * @param proof Proof 数组
   * @param root Merkle Root
   * @returns 是否有效
   */
  verify(leaf: `0x${string}`, proof: `0x${string}`[], root: `0x${string}`): boolean {
    const leafBuffer = Buffer.from(leaf.slice(2), "hex");
    const proofBuffers = proof.map((p) => Buffer.from(p.slice(2), "hex"));
    const rootBuffer = Buffer.from(root.slice(2), "hex");
    
    return this.tree.verify(proofBuffers, leafBuffer, rootBuffer);
  }

  /**
   * 获取所有叶子节点（用于调试）
   */
  getLeaves(): `0x${string}`[] {
    return this.leaves.map((leaf) => `0x${leaf.toString("hex")}` as `0x${string}`);
  }

  /**
   * 获取树的层数（用于调试）
   */
  getDepth(): number {
    return this.tree.getDepth();
  }
}

