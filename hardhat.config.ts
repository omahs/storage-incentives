import 'dotenv/config';
import { HardhatUserConfig } from 'hardhat/types';
import 'solidity-coverage';
import 'hardhat-deploy';
import 'hardhat-deploy-ethers';
import { task } from "hardhat/config";
import { ContractTransaction, ContractReceipt } from 'ethers';
import { boolean, int, string  } from 'hardhat/internal/core/params/argumentTypes';

require("@nomiclabs/hardhat-ethers");

const GOERLI_PRIVATE_KEY = "/";
const PRIVATE_KEY = "/";
task("copy", "A sample task with params")
  .addParam("owner", "")
  .addParam("batchid", "", "", string)
  .addParam("initialbalance", "", 0, int)
  .addParam("depth", "")
  .addParam("bucketdepth", "", 16, int)
  .addParam("immutable", "", false, boolean)
  .addParam("postagecontract", "", "")
  .addParam("tokenaddress", "", "")
  .setAction(async (taskArgs, { ethers }) => {

    const [deployer] = await ethers.getSigners();

    const PostageStamp = await ethers.getContractFactory("PostageStamp");
    const contract = PostageStamp.attach(taskArgs.postagecontract);

    const TestToken = await ethers.getContractFactory("TestToken");
    const token = TestToken.attach(taskArgs.tokenaddress);

    let transferAmount = taskArgs.initialbalance * 2 ** taskArgs.depth;

    let result: ContractTransaction;
    let receipt: ContractReceipt;

    result = await token.connect(deployer).approve(contract.address, transferAmount);
    receipt = await result.wait();

    let batchid = `${taskArgs.batchid}`;
    if (!batchid.startsWith("0x")) {
      batchid = "0x" + batchid
    }


    // Now you can call functions of the contract
    result = await contract.copyBatch(ethers.utils.getAddress(taskArgs.owner), taskArgs.initialbalance, taskArgs.depth, taskArgs.bucketdepth, batchid, taskArgs.immutable);
    receipt = await result.wait();
  });


// Define mnemonic for accounts.
let mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  // NOTE: this fallback is for development only!
  // When using other networks, set the secret in .env.
  // DO NOT commit or share your mnemonic with others!
  mnemonic = 'test test test test test test test test test test test test';
}

const accounts = { mnemonic };

// Config for hardhat.
const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.1',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  // mocha: {
  //   timeout: 100000000
  // },
  namedAccounts: {
    deployer: 0,
    admin: 1,
    stamper: 2,
    oracle: 3,
  },
  defaultNetwork: "private",
  networks: {
    hardhat: {
      initialBaseFeePerGas: 0,
      accounts,
    },
    localhost: {
      url: 'http://localhost:8545',
      accounts,
    },
    staging: {
      url: 'https://goerli.infura.io/v3/' + process.env.INFURA_TOKEN,
      accounts,
    },
    private: {
      url: 'http://geth-incentives-test.testnet.internal',
      accounts: [process.env.PRIVATE_KEY as string],
      gas: 30_000_000,
      gasPrice: 10_000_000,
    }
  },
  paths: {
    sources: 'src',
  },
};

export default config;

// // result = await token.connect(deployer).mint(deployer.address, "1000000000000000000");
// result = await token.connect(deployer).balanceOf(deployer.address);
// // receipt = await result.wait();
// console.log("approve receipt", result);
// return

// result = await token.connect(deployer).balanceOf(deployer.address);
// result = await token.connect(deployer).balanceOf(deployer.address);
// let receipt: ContractReceipt = await result.wait();
// console.log("approve receipt", result);
// return

// module.exports = {
//   solidity: "0.8.1",
//   networks: {
//     // goerli: {
//     //   url: `https://goerli.prylabs.net/`,
//     //   accounts: [`${GOERLI_PRIVATE_KEY}`],
//     //   gasPrice: 9_690_000,
//     //   gas: 30_000_000
//     // }
//     private: {
//       url: `http://geth-incentives-test.testnet.internal`,
//       accounts: [`${PRIVATE_KEY}`]
//     }
//   },
//   etherscan: {
//     apiKey: {
//       goerli: '8BG68Q43RV7P7VPQ2QGWGHHTBAIU9MNSA1'
//     }
//   }
// };
