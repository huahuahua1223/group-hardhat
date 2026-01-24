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
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
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
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    arbitrum: {
      type: "http",
      chainType: "l1",
      url: configVariable("ARBITRUM_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    opbnb: {
      type: "http",
      chainType: "op",
      url: configVariable("OPBNB_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    gnosis: {
      type: "http",
      chainType: "l1",
      url: configVariable("GNOSIS_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
  verify: {
    etherscan: {
      // 统一的 Etherscan V2 API key
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
  ignition: {
    strategyConfig: {
      create2: {
        // EOA + 00 + 熵 (32 bytes)
        salt: "0x0041d9424581231161d75af27b8ab92090d3725e000000000000000000001234",
      },
    },
  },
};

export default config;
