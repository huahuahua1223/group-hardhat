import type { Address } from "viem";

/**
 * 链配置类型定义
 */
export type ChainConfig = {
  name: string;                          // 链名称（用于输出目录）
  outputDir: string;                     // 输出目录路径
  tokens: Record<string, Address>;       // 代币地址映射
  avatars: Record<string, string>;       // 代币头像 CID 映射
  factoryEnvKey: string;                 // Factory 地址环境变量名
  redPacketEnvKey: string;               // RedPacket 地址环境变量名
};

/**
 * 所有链的配置（以 chainId 为 key）
 */
export const CHAIN_CONFIG: Record<number, ChainConfig> = {
  // Arbitrum One (chainId 42161)
  42161: {
    name: "arbitrum",
    outputDir: "./output/arbitrum",
    factoryEnvKey: "FACTORY_ADDRESS_ARBITRUM",
    redPacketEnvKey: "RED_PACKET_ADDRESS_ARBITRUM",
    tokens: {
      ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548" as Address,
      USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address,
      WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address,
    },
    avatars: {
      ARB: "bafkreihfrzi6bbjt6eap3e6xwlgwyhck3fcwxs6eujegzhhpaqpijz3tim",
      USDT: "bafkreibn4y6llleughtp5pgu37lve7mymvcffpo5i2h6iw4t4iwo6z5ocu",
      WETH: "bafkreicijvbdd5rbejczpxv47ttblwsbjqsijxzml4svwsekdojbejilfe",
    },
  },

  // opBNB Mainnet (chainId 204)
  204: {
    name: "opbnb",
    outputDir: "./output/opbnb",
    factoryEnvKey: "FACTORY_ADDRESS_OPBNB",
    redPacketEnvKey: "RED_PACKET_ADDRESS_OPBNB",
    tokens: {
      USDT: "0x0000000000000000000000000000000000000000" as Address,
      WETH: "0x0000000000000000000000000000000000000000" as Address,
      WBNB: "0x0000000000000000000000000000000000000000" as Address,
    },
    avatars: {
      USDT: "bafkrei...",
      WETH: "bafkrei...",
      WBNB: "bafkrei...",
    },
  },

  // Gnosis Chain (chainId 100)
  100: {
    name: "gnosis",
    outputDir: "./output/gnosis",
    factoryEnvKey: "FACTORY_ADDRESS_GNOSIS",
    redPacketEnvKey: "RED_PACKET_ADDRESS_GNOSIS",
    tokens: {
      USDT: "0x0000000000000000000000000000000000000000" as Address,
      WETH: "0x0000000000000000000000000000000000000000" as Address,
      xDAI: "0x0000000000000000000000000000000000000000" as Address,
    },
    avatars: {
      USDT: "bafkrei...",
      WETH: "bafkrei...",
      xDAI: "bafkrei...",
    },
  },
};

/**
 * 获取链配置的工具函数
 * @param chainId 链 ID
 * @returns 链配置对象
 * @throws 如果链 ID 未配置则抛出错误
 */
export function getChainConfig(chainId: number): ChainConfig {
  const config = CHAIN_CONFIG[chainId];
  if (!config) {
    throw new Error(
      `未配置的链: chainId=${chainId}\n支持的链: ${Object.keys(CHAIN_CONFIG).join(", ")}`
    );
  }
  return config;
}

