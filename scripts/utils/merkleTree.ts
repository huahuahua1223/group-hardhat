import { keccak256, encodePacked, type Address } from "viem";

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
 * 简单的 Merkle Tree 实现（用于测试）
 */
export class MerkleTree {
  private leaves: `0x${string}`[];
  private layers: `0x${string}`[][];

  constructor(leaves: `0x${string}`[]) {
    this.leaves = [...leaves].sort();
    this.layers = this.buildTree(this.leaves);
  }

  private buildTree(leaves: `0x${string}`[]): `0x${string}`[][] {
    if (leaves.length === 0) {
      throw new Error("Cannot build tree with no leaves");
    }

    const layers: `0x${string}`[][] = [leaves];
    
    while (layers[layers.length - 1].length > 1) {
      layers.push(this.getNextLayer(layers[layers.length - 1]));
    }

    return layers;
  }

  private getNextLayer(layer: `0x${string}`[]): `0x${string}`[] {
    const nextLayer: `0x${string}`[] = [];

    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) {
        const [left, right] = [layer[i], layer[i + 1]].sort();
        nextLayer.push(keccak256(encodePacked(["bytes32", "bytes32"], [left, right])));
      } else {
        // 奇数个节点，最后一个直接提升
        nextLayer.push(layer[i]);
      }
    }

    return nextLayer;
  }

  getRoot(): `0x${string}` {
    return this.layers[this.layers.length - 1][0];
  }

  getProof(leaf: `0x${string}`): `0x${string}`[] {
    let index = this.leaves.indexOf(leaf);
    if (index === -1) {
      throw new Error("Leaf not found in tree");
    }

    const proof: `0x${string}`[] = [];

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = index % 2 === 1;
      const siblingIndex = isRightNode ? index - 1 : index + 1;

      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }

      index = Math.floor(index / 2);
    }

    return proof;
  }

  verify(leaf: `0x${string}`, proof: `0x${string}`[], root: `0x${string}`): boolean {
    let computedHash = leaf;

    for (const proofElement of proof) {
      const [left, right] = [computedHash, proofElement].sort();
      computedHash = keccak256(encodePacked(["bytes32", "bytes32"], [left, right]));
    }

    return computedHash === root;
  }
}

