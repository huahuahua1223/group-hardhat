import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable } from "hardhat/config";
import { config as dotenvConfig } from "dotenv";

// 加载 .env 文件中的环境变量
// configVariable() 会优先使用 Hardhat vars，如果没有则使用环境变量
dotenvConfig();

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
    arbitrum: {
      type: "http",
      chainType: "l1",
      url: configVariable("ARBITRUM_RPC_URL"),
      accounts: [configVariable("ARBITRUM_PRIVATE_KEY")],
    },
  },
  verify: {
    etherscan: {
      // 统一的 Etherscan V2 API key
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
};

export default config;
