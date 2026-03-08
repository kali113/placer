import { config as loadEnv } from "dotenv";
import { defineConfig } from "hardhat/config";

loadEnv();

const optimizerSettings = {
  enabled: true,
  runs: 200
};

export default defineConfig({
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          viaIR: true,
          optimizer: optimizerSettings
        }
      },
      {
        version: "0.8.30",
        settings: {
          viaIR: true,
          optimizer: optimizerSettings
        }
      }
    ]
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1"
    },
    somniaShannon: {
      type: "http",
      chainType: "l1",
      chainId: 50312,
      url: process.env.SOMNIA_RPC_URL ?? "https://dream-rpc.somnia.network",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
    }
  },
  paths: {
    sources: "./contracts",
    artifacts: "./artifacts",
    cache: "./cache"
  }
});
