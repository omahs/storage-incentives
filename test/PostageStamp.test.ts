import { expect } from './util/chai';
import { ethers, deployments, getNamedAccounts, getUnnamedAccounts } from 'hardhat';
import { Contract, Signer } from 'ethers';
import { mineNBlocks, computeBatchId, mintAndApprove, getBlockNumber } from './util/tools';

// Named accounts used by tests.
let stamper: string;
let deployer: string;
let oracle: string;
let others: string[];

// Before the tests, set named accounts and read deployments.
before(async function () {
  const namedAccounts = await getNamedAccounts();
  deployer = namedAccounts.deployer;
  stamper = namedAccounts.stamper;
  oracle = namedAccounts.oracle;
  others = await getUnnamedAccounts();
});

async function setPrice(price: number) {
  return await (await ethers.getContract('PostageStamp', oracle)).setPrice(price);
}

const zeroAddress = '0x0000000000000000000000000000000000000000';

const errors = {
  manual: {
    notAdmin: 'caller is not the admin',
  },
  auto: {
    notZero: 'unexpected zero',
  },
};

describe('PostageStamp', function () {
  describe('when deploying contract', function () {
    beforeEach(async function () {
      await deployments.fixture();
    });

    it('should deploy PostageStamp', async function () {
      const postageStamp = await ethers.getContract('PostageStamp');
      expect(postageStamp.address).to.be.properAddress;
    });

    it('should set the correct token', async function () {
      const postageStamp = await ethers.getContract('PostageStamp');
      const token = await ethers.getContract('TestToken');
      expect(await postageStamp.bzzToken()).to.be.eq(token.address);
    });

    it('should assign the admin role', async function () {
      const postageStamp = await ethers.getContract('PostageStamp');
      const adminRole = await postageStamp.DEFAULT_ADMIN_ROLE();
      expect(await postageStamp.hasRole(adminRole, deployer)).to.be.true;
    });

    it('should assign the pauser role', async function () {
      const postageStamp = await ethers.getContract('PostageStamp');
      const pauserRole = await postageStamp.PAUSER_ROLE();
      expect(await postageStamp.hasRole(pauserRole, deployer)).to.be.true;
    });
  });

  describe('with deployed contract', async function () {
    let postageStamp: Contract, token: Contract, oracle: Contract;
    let batch: any;
    let batchSize: number, transferAmount: number;
    let price0 = 1024;
    let setPrice0Block: number;

    beforeEach(async function () {
      await deployments.fixture();
    });

    describe('when creating a batch', function () {
      beforeEach(async function () {

        postageStamp = await ethers.getContract('PostageStamp', stamper);
        token = await ethers.getContract('TestToken', deployer);
        oracle = await ethers.getContract('PriceOracle', deployer);

        setPrice0Block = await getBlockNumber();
        await oracle.setPrice(price0);

        batch = {
          nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
          initialPaymentPerChunk: price0 * 10, //good for ten blocks at minimum price
          depth: 17,
          immutable: false,
          bucketDepth: 16,
        };

        batchSize = 2 ** batch.depth;
        transferAmount = batch.initialPaymentPerChunk * batchSize;

        batch.id = computeBatchId(stamper, batch.nonce);

        await mintAndApprove(deployer, stamper, postageStamp.address, transferAmount.toString());
      });

      it('should fire the BatchCreated event', async function () {
        const blocksElapsed = (await getBlockNumber()) - setPrice0Block;
        const expectedNormalisedBalance = batch.initialPaymentPerChunk + blocksElapsed * price0;
        await expect(
          postageStamp.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        )
          .to.emit(postageStamp, 'BatchCreated')
          .withArgs(
            batch.id,
            transferAmount,
            expectedNormalisedBalance,
            stamper,
            batch.depth,
            batch.bucketDepth,
            batch.immutable
          );
      });

      it('should store the batch', async function () {
        const blocksElapsed = (await getBlockNumber()) - setPrice0Block;
        const expectedNormalisedBalance = batch.initialPaymentPerChunk + blocksElapsed * price0;
        await postageStamp.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        const stamp = await postageStamp.batches(batch.id);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(batch.depth);
        expect(stamp[2]).to.equal(batch.immutable);
        expect(stamp[3]).to.equal(expectedNormalisedBalance);
      });

      it('should report the correct remaining balance', async function () {
        const blocksElapsed = (await getBlockNumber()) - setPrice0Block;
        const expectedNormalisedBalance = batch.initialPaymentPerChunk + blocksElapsed * price0;

        await postageStamp.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        const buyStampBlock = await getBlockNumber();

        const stamp = await postageStamp.batches(batch.id);
        console.log(stamp);

        let normalisedBalance0 = parseInt(await postageStamp.remainingBalance(batch.id));
        let expectedNormalisedBalance0 = batch.initialPaymentPerChunk - ((await getBlockNumber()) - buyStampBlock) * price0;

        expect(normalisedBalance0).to.be.equal(expectedNormalisedBalance0);

        await mineNBlocks(1);

        let normalisedBalance1 = parseInt(await postageStamp.remainingBalance(batch.id));
        let expectedNormalisedBalance1 = batch.initialPaymentPerChunk - ((await getBlockNumber()) - buyStampBlock) * price0;

        expect(normalisedBalance1).to.be.equal(expectedNormalisedBalance1);
        await mineNBlocks(12);

        let expectedNormalisedBalance2 = batch.initialPaymentPerChunk - ((await getBlockNumber()) - buyStampBlock) * price0;
        let normalisedBalance2 = await postageStamp.remainingBalance(batch.id);

        expect(expectedNormalisedBalance2).to.be.lessThan(0);
        expect(normalisedBalance2).to.be.equal(0);

        await postageStamp.expire();

        await expect(
          postageStamp.remainingBalance(batch.id)
        ).to.be.revertedWith('batch does not exist or expired');
      });

      it('should keep batches ordered by normalisedBalance', async function () {
        const initialPaymentPerChunk0 = 3300;
        const initialPaymentPerChunk1 = 1100;
        const initialPaymentPerChunk2 = 2200;

        const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
        await postageStamp.createBatch(
          stamper,
          initialPaymentPerChunk0,
          batch.depth,
          batch.bucketDepth,
          nonce0,
          batch.immutable
        );
        const batch0 = computeBatchId(stamper, nonce0);
        expect(batch0).equal(await postageStamp.firstBatchId());

        const blocksElapsed = (await getBlockNumber()) - setPrice0Block;
        const expectedNormalisedBalance1 = initialPaymentPerChunk1 + blocksElapsed * price0;

        const nonce1 = '0x0000000000000000000000000000000000000000000000000000000000001235';
        await postageStamp.createBatch(
          stamper,
          initialPaymentPerChunk1,
          batch.depth,
          batch.bucketDepth,
          nonce1,
          batch.immutable
        );
        const batch1 = computeBatchId(stamper, nonce1);
        expect(batch1).equal(await postageStamp.firstBatchId());

        const nonce2 = '0x0000000000000000000000000000000000000000000000000000000000001236';
        await postageStamp.createBatch(
          stamper,
          initialPaymentPerChunk2,
          batch.depth,
          batch.bucketDepth,
          nonce2,
          batch.immutable
        );

        const batch2 = computeBatchId(stamper, nonce2);
        expect(batch1).equal(await postageStamp.firstBatchId());
        expect(batch2).not.equal(await postageStamp.firstBatchId());

        const stamp = await postageStamp.batches(batch1);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(batch.depth);
        expect(stamp[2]).to.equal(batch.immutable);
        expect(stamp[3]).to.equal(expectedNormalisedBalance1);
      });

      it('should transfer the token', async function () {
        await postageStamp.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        expect(await token.balanceOf(stamper)).to.equal(0);
        expect(await token.balanceOf(postageStamp.address)).to.equal(transferAmount);
      });

      it('should not create batch if insufficient funds', async function () {
        await expect(
          postageStamp.createBatch(
            stamper,
            batch.initialPaymentPerChunk + 1,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance');
      });

      it('should not allow zero as bucket depth', async function () {
        await expect(
          postageStamp.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            0,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('invalid bucket depth');
      });

      it('should not allow bucket depth larger than depth', async function () {
        await expect(
          postageStamp.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.depth + 1,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('invalid bucket depth');
      });

      it('should not allow bucket depth equal to depth', async function () {
        await expect(
          postageStamp.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.depth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('invalid bucket depth');
      });

      it('should not allow duplicate batch', async function () {
        await postageStamp.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );
        await expect(
          postageStamp.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('batch already exists');
      });

      // it('should not allow normalized balance to be zero', async function () {
      //   await expect(
      //     postageStamp.createBatch(
      //       stamper,
      //       0,
      //       batch.depth,
      //       batch.bucketDepth,
      //       batch.nonce,
      //       batch.immutable
      //     )
      //   ).to.be.revertedWith('normalisedBalance cannot be zero');
      // });

      it('should correctly return if batches are empty', async function () {
        const initialPaymentPerChunk0 = 2048;
        const blocksElapsed = (await getBlockNumber()) - setPrice0Block;
        const expectedNormalisedBalance = initialPaymentPerChunk0 + blocksElapsed * price0;

        await postageStamp.createBatch(
          stamper,
          initialPaymentPerChunk0,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );

        const stamp = await postageStamp.batches(batch.id);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(batch.depth);
        expect(stamp[2]).to.equal(batch.immutable);
        expect(stamp[3]).to.equal(expectedNormalisedBalance);
        expect(await postageStamp.empty()).equal(false);

        mineNBlocks(10);
        await postageStamp.expire();

        expect(await postageStamp.empty()).equal(true);
      });

      it('should not allow batch creation when paused', async function () {
        const postageStamp = await ethers.getContract('PostageStamp', deployer);
        await postageStamp.pause();
        await expect(
          postageStamp.createBatch(
            stamper,
            0,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('Pausable: paused');
      });


      it('should allow batch creation when unpaused', async function () {
        const postage_p = await ethers.getContract('PostageStamp', deployer);
        await postage_p.pause();
        await expect(
          postageStamp.createBatch(
            stamper,
            batch.initialPaymentPerChunk,
            batch.depth,
            batch.bucketDepth,
            batch.nonce,
            batch.immutable
          )
        ).to.be.revertedWith('Pausable: paused');
        await postage_p.unPause();

        const initialPaymentPerChunk0 = 2048;
        const blocksElapsed = (await getBlockNumber()) - setPrice0Block;
        const expectedNormalisedBalance = batch.initialPaymentPerChunk + blocksElapsed * price0;
        await postageStamp.createBatch(
          stamper,
          batch.initialPaymentPerChunk,
          batch.depth,
          batch.bucketDepth,
          batch.nonce,
          batch.immutable
        );

        const stamp = await postageStamp.batches(batch.id);
        expect(stamp[0]).to.equal(stamper);
        expect(stamp[1]).to.equal(batch.depth);
        expect(stamp[2]).to.equal(batch.immutable);
        expect(stamp[3]).to.equal(expectedNormalisedBalance);
      });

      it('should delete expired batches', async function () {
        const initialPaymentPerChunk0 = price0 * 8;
        const initialPaymentPerChunk1 = price0 * 4;
        const initialPaymentPerChunk2 = price0 * 16;
        // const initialPaymentPerChunk3 = price0;

        const transferAmount0 = initialPaymentPerChunk0 * 2 ** batch.depth;
        await mintAndApprove(deployer, stamper, postageStamp.address, transferAmount0.toString());

        const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
        await postageStamp.createBatch(
          stamper,
          initialPaymentPerChunk0,
          batch.depth,
          batch.bucketDepth,
          nonce0,
          batch.immutable
        );

        const buyStamp0Block = await getBlockNumber();

        const batch0 = computeBatchId(stamper, nonce0);
        expect(await postageStamp.firstBatchId()).to.equal(batch0);

        // expect(await postageStamp.pot()).equal(0);

        const transferAmount1 = initialPaymentPerChunk1 * 2 ** batch.depth;
        await mintAndApprove(deployer, stamper, postageStamp.address, transferAmount1.toString());

        const batch1CreatedBlock = await getBlockNumber();
        const nonce1 = '0x0000000000000000000000000000000000000000000000000000000000001235';
        await postageStamp.createBatch(
          stamper,
          initialPaymentPerChunk1,
          batch.depth,
          batch.bucketDepth,
          nonce1,
          batch.immutable
        );

        const buyStamp1Block = await getBlockNumber();

        const batch1 = computeBatchId(stamper, nonce1);
        expect(await postageStamp.firstBatchId()).to.equal(batch1);

        // expect(await postageStamp.pot()).equal(1 << batch.depth);

        const transferAmount2 = initialPaymentPerChunk2 * 2 ** batch.depth;
        await mintAndApprove(deployer, stamper, postageStamp.address, transferAmount2.toString());

        const nonce2 = '0x0000000000000000000000000000000000000000000000000000000000001236';
        await postageStamp.createBatch(
          stamper,
          initialPaymentPerChunk2,
          batch.depth,
          batch.bucketDepth,
          nonce2,
          batch.immutable
        );

        const buyStamp2Block = await getBlockNumber();

        const batch2 = computeBatchId(stamper, nonce2);
        expect(await postageStamp.firstBatchId()).to.equal(batch1);
        expect(await postageStamp.firstBatchId()).not.to.equal(batch2);

        const outpaymentSinceBuyStamp0 = ((await getBlockNumber()) - buyStamp0Block) * price0;
        const outpaymentSinceBuyStamp1 = ((await getBlockNumber()) - buyStamp1Block) * price0;
        const outpaymentSinceBuyStamp2 = ((await getBlockNumber()) - buyStamp2Block) * price0;

        expect(await postageStamp.remainingBalance(batch0)).to.equal(initialPaymentPerChunk0 - outpaymentSinceBuyStamp0);
        expect(await postageStamp.remainingBalance(batch1)).to.equal(initialPaymentPerChunk1 - outpaymentSinceBuyStamp1);
        expect(await postageStamp.remainingBalance(batch2)).to.equal(initialPaymentPerChunk2 - outpaymentSinceBuyStamp2);

        console.log((await postageStamp.currentTotalOutPayment()).toString());

        await mineNBlocks(1);

        expect(await postageStamp.firstBatchId()).to.equal(batch1);
        expect(await postageStamp.firstBatchId()).not.to.equal(batch2);

        console.log(parseInt(await postageStamp.remainingBalance(batch0)));
        console.log(parseInt(await postageStamp.remainingBalance(batch1)));
        console.log(parseInt(await postageStamp.remainingBalance(batch2)));

        const outpaymentSinceBuyStamp0_2 = ((await getBlockNumber()) - buyStamp0Block) * price0;
        const outpaymentSinceBuyStamp1_2 = ((await getBlockNumber()) - buyStamp1Block) * price0;
        const outpaymentSinceBuyStamp2_2 = ((await getBlockNumber()) - buyStamp2Block) * price0;

        expect(await postageStamp.remainingBalance(batch0)).to.equal(initialPaymentPerChunk0 - outpaymentSinceBuyStamp0_2);
        expect(await postageStamp.remainingBalance(batch1)).to.equal(initialPaymentPerChunk1 - outpaymentSinceBuyStamp1_2);
        expect(await postageStamp.remainingBalance(batch2)).to.equal(initialPaymentPerChunk2 - outpaymentSinceBuyStamp2_2);

        console.log(parseInt(await postageStamp.remainingBalance(batch0)));
        console.log(parseInt(await postageStamp.remainingBalance(batch1)));
        console.log(parseInt(await postageStamp.remainingBalance(batch2)));

        await postageStamp.expire();

        const outpaymentSinceBuyStamp2_3 = ((await getBlockNumber()) - buyStamp2Block) * price0;

        await expect(postageStamp.remainingBalance(batch0)).to.be.revertedWith('batch does not exist or expired');
        await expect(postageStamp.remainingBalance(batch1)).to.be.revertedWith('batch does not exist or expired');
        expect(await postageStamp.remainingBalance(batch2)).to.equal(initialPaymentPerChunk2 - outpaymentSinceBuyStamp2_3);

        expect(batch0).not.equal(await postageStamp.firstBatchId());
        expect(batch1).not.equal(await postageStamp.firstBatchId());
        expect(batch2).equal(await postageStamp.firstBatchId());
      });

      // it('should delete many expired batches', async function () {
      //   const price = 2048;
      //   await setPrice(price);

      //   transferAmount = 2000 * batch.initialPaymentPerChunk * batchSize;
      //   expectedNormalisedBalance = batch.initialPaymentPerChunk;

      //   await token.mint(stamper, transferAmount);
      //   (await ethers.getContract('TestToken', stamper)).approve(postageStamp.address, transferAmount);

      //   for (let i = 0; i < 20; i++) {
      //     const nonce =
      //       '0x000000000000000000000000000000000000000000000000000000000000' + i.toString().padStart(4, '0');
      //     await postageStamp.createBatch(
      //       stamper,
      //       10240 - i,
      //       batch.depth,
      //       batch.bucketDepth,
      //       nonce,
      //       batch.immutable
      //     );
      //   }

      //   await mineNBlocks(5);

      //   const nonce3 = '0x0000000000000000000000000000000000000000000000000000000000011237';
      //   await postageStamp.createBatch(
      //     stamper,
      //     4096,
      //     batch.depth,
      //     batch.bucketDepth,
      //     nonce3,
      //     batch.immutable
      //   );

      //   expect(await postageStamp.pot()).equal(210 * 2 ** batch.depth);
      // });
    });

    // describe('when copyBatch creates a batch', function () {
    //   beforeEach(async function () {
    //     postageStampContract = await ethers.getContract('PostageStamp', deployer);

    //     postageStamp = await ethers.getContract('PostageStamp', stamper);
    //     token = await ethers.getContract('TestToken', deployer);

    //     batch = {
    //       nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
    //       initialPaymentPerChunk: 10240,
    //       depth: 17,
    //       immutable: false,
    //       bucketDepth: 16,
    //     };

    //     batchSize = 2 ** batch.depth;
    //     transferAmount = batch.initialPaymentPerChunk * batchSize;
    //     expectedNormalisedBalance = batch.initialPaymentPerChunk;

    //     batch.id = batch.nonce;

    //     const admin = await postageStamp.DEFAULT_ADMIN_ROLE();
    //     await postageStampContract.grantRole(admin, stamper);

    //     await token.mint(stamper, transferAmount);
    //     (await ethers.getContract('TestToken', stamper)).approve(postageStamp.address, transferAmount);
    //   });

    //   it('should fire the BatchCreated event', async function () {
    //     await expect(
    //       postageStamp.copyBatch(
    //         stamper,
    //         batch.initialPaymentPerChunk,
    //         batch.depth,
    //         batch.bucketDepth,
    //         batch.nonce,
    //         batch.immutable
    //       )
    //     )
    //       .to.emit(postageStamp, 'BatchCreated')
    //       .withArgs(
    //         batch.nonce,
    //         transferAmount,
    //         expectedNormalisedBalance,
    //         stamper,
    //         batch.depth,
    //         batch.bucketDepth,
    //         batch.immutable
    //       );
    //   });

    //   it('should store the batch', async function () {
    //     await postageStamp.copyBatch(
    //       stamper,
    //       batch.initialPaymentPerChunk,
    //       batch.depth,
    //       batch.bucketDepth,
    //       batch.nonce,
    //       batch.immutable
    //     );
    //     const stamp = await postageStamp.batches(batch.id);
    //     expect(stamp[0]).to.equal(stamper);
    //     expect(stamp[1]).to.equal(batch.depth);
    //     expect(stamp[2]).to.equal(batch.immutable);
    //     expect(stamp[3]).to.equal(expectedNormalisedBalance);
    //   });

    //   it('should keep batches ordered by normalisedBalance', async function () {
    //     const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
    //     const batch0 = computeBatchId(stamper, nonce0);

    //     await postageStamp.copyBatch(
    //       stamper,
    //       3300,
    //       batch.depth,
    //       batch.bucketDepth,
    //       batch0,
    //       batch.immutable
    //     );
    //     expect(batch0).equal(await postageStamp.firstBatchId());

    //     const nonce1 = '0x0000000000000000000000000000000000000000000000000000000000001235';
    //     const batch1 = computeBatchId(stamper, nonce1);

    //     await postageStamp.copyBatch(
    //       stamper,
    //       11,
    //       batch.depth,
    //       batch.bucketDepth,
    //       batch1,
    //       batch.immutable
    //     );
    //     expect(batch1).equal(await postageStamp.firstBatchId());

    //     const nonce2 = '0x0000000000000000000000000000000000000000000000000000000000001236';
    //     const batch2 = computeBatchId(stamper, nonce2);
    //     await postageStamp.copyBatch(
    //       stamper,
    //       2200,
    //       batch.depth,
    //       batch.bucketDepth,
    //       batch2,
    //       batch.immutable
    //     );
    //     expect(batch1).equal(await postageStamp.firstBatchId());
    //     expect(batch2).not.equal(await postageStamp.firstBatchId());

    //     const stamp = await postageStamp.batches(batch1);
    //     expect(stamp[0]).to.equal(stamper);
    //     expect(stamp[1]).to.equal(batch.depth);
    //     expect(stamp[2]).to.equal(batch.immutable);
    //     expect(stamp[3]).to.equal(11);
    //   });

    //   it('should transfer the token', async function () {
    //     await postageStamp.copyBatch(
    //       stamper,
    //       batch.initialPaymentPerChunk,
    //       batch.depth,
    //       batch.bucketDepth,
    //       batch.nonce,
    //       batch.immutable
    //     );
    //     expect(await token.balanceOf(stamper)).to.equal(0);
    //   });

    //   it('should not create batch if insufficient funds', async function () {
    //     await expect(
    //       postageStamp.copyBatch(
    //         stamper,
    //         batch.initialPaymentPerChunk + 1,
    //         batch.depth,
    //         batch.bucketDepth,
    //         batch.nonce,
    //         batch.immutable
    //       )
    //     ).to.be.revertedWith('ERC20: transfer amount exceeds balance');
    //   });

    //   it('should not allow zero address as owner', async function () {
    //     await expect(
    //       postageStamp.copyBatch(
    //         zeroAddress,
    //         batch.initialPaymentPerChunk,
    //         batch.depth,
    //         batch.bucketDepth,
    //         batch.nonce,
    //         batch.immutable
    //       )
    //     ).to.be.revertedWith('owner cannot be the zero address');
    //   });

    //   it('should not allow zero as bucket depth', async function () {
    //     await expect(
    //       postageStamp.copyBatch(
    //         stamper,
    //         batch.initialPaymentPerChunk,
    //         batch.depth,
    //         0,
    //         batch.nonce,
    //         batch.immutable
    //       )
    //     ).to.be.revertedWith('invalid bucket depth');
    //   });

    //   it('should not allow bucket depth larger than depth', async function () {
    //     await expect(
    //       postageStamp.copyBatch(
    //         stamper,
    //         batch.initialPaymentPerChunk,
    //         batch.depth,
    //         batch.depth + 1,
    //         batch.nonce,
    //         batch.immutable
    //       )
    //     ).to.be.revertedWith('invalid bucket depth');
    //   });

    //   it('should not allow bucket depth equal to depth', async function () {
    //     await expect(
    //       postageStamp.copyBatch(
    //         stamper,
    //         batch.initialPaymentPerChunk,
    //         batch.depth,
    //         batch.depth,
    //         batch.nonce,
    //         batch.immutable
    //       )
    //     ).to.be.revertedWith('invalid bucket depth');
    //   });

    //   it('should not allow duplicate batch', async function () {
    //     await postageStamp.copyBatch(
    //       stamper,
    //       1000,
    //       batch.depth,
    //       batch.bucketDepth,
    //       batch.nonce,
    //       batch.immutable
    //     );
    //     await expect(
    //       postageStamp.copyBatch(
    //         stamper,
    //         1000,
    //         batch.depth,
    //         batch.bucketDepth,
    //         batch.nonce,
    //         batch.immutable
    //       )
    //     ).to.be.revertedWith('batch already exists');
    //   });

    //   it('should not allow normalized balance to be zero', async function () {
    //     await expect(
    //       postageStamp.copyBatch(
    //         stamper,
    //         0,
    //         batch.depth,
    //         batch.bucketDepth,
    //         batch.nonce,
    //         batch.immutable
    //       )
    //     ).to.be.revertedWith('normalisedBalance cannot be zero');
    //   });

    //   it('should not return empty batches', async function () {
    //     await postageStamp.copyBatch(
    //       stamper,
    //       batch.initialPaymentPerChunk,
    //       batch.depth,
    //       batch.bucketDepth,
    //       batch.nonce,
    //       batch.immutable
    //     );
    //     const stamp = await postageStamp.batches(batch.id);
    //     expect(stamp[0]).to.equal(stamper);
    //     expect(stamp[1]).to.equal(batch.depth);
    //     expect(stamp[2]).to.equal(batch.immutable);
    //     expect(stamp[3]).to.equal(expectedNormalisedBalance);
    //     const isEmpty = await postageStamp.empty();
    //     expect(isEmpty).equal(false);
    //   });

    //   it('should not allow batch creation when paused', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', deployer);
    //     await postageStamp.pause();
    //     await expect(
    //       postageStamp.copyBatch(
    //         stamper,
    //         0,
    //         batch.depth,
    //         batch.bucketDepth,
    //         batch.nonce,
    //         batch.immutable
    //       )
    //     ).to.be.revertedWith('Pausable: paused');
    //   });

    //   it('should include totalOutpayment in the normalised balance', async function () {
    //     const price = 100;
    //     await setPrice(price);

    //     await expect(
    //       postageStamp.copyBatch(
    //         stamper,
    //         batch.initialPaymentPerChunk,
    //         batch.depth,
    //         batch.bucketDepth,
    //         batch.nonce,
    //         batch.immutable
    //       )
    //     )
    //       .to.emit(postageStamp, 'BatchCreated')
    //       .withArgs(
    //         batch.id,
    //         transferAmount,
    //         price + expectedNormalisedBalance,
    //         stamper,
    //         batch.depth,
    //         batch.bucketDepth,
    //         batch.immutable
    //       );
    //     const stamp = await postageStamp.batches(batch.id);
    //     expect(stamp[3]).to.equal(price + expectedNormalisedBalance);
    //   });

    //   it('should include pending totalOutpayment in the normalised balance', async function () {
    //     const price = 100;
    //     await setPrice(price);

    //     // mine two blocks, therefore when the next copyBatch happens the totalOutpayment increased 3 times
    //     await ethers.provider.send('evm_mine', []);
    //     await ethers.provider.send('evm_mine', []);

    //     await expect(
    //       postageStamp.copyBatch(
    //         stamper,
    //         batch.initialPaymentPerChunk,
    //         batch.depth,
    //         batch.bucketDepth,
    //         batch.nonce,
    //         batch.immutable
    //       )
    //     )
    //       .to.emit(postageStamp, 'BatchCreated')
    //       .withArgs(
    //         batch.id,
    //         transferAmount,
    //         3 * price + expectedNormalisedBalance,
    //         stamper,
    //         batch.depth,
    //         batch.bucketDepth,
    //         batch.immutable
    //       );
    //     const stamp = await postageStamp.batches(batch.id);
    //     expect(stamp[3]).to.equal(3 * price + expectedNormalisedBalance);
    //   });
    // });

    // describe('when topping up a batch', function () {
    //   beforeEach(async function () {
    //     postageStamp = await ethers.getContract('PostageStamp', stamper);
    //     token = await ethers.getContract('TestToken', deployer);

    //     batch = {
    //       nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
    //       initialPaymentPerChunk: 200,
    //       depth: 17,
    //       bucketDepth: 16,
    //       immutable: false,
    //     };

    //     batch.id = computeBatchId(stamper, batch.nonce);
    //     topupAmountPerChunk = 100;

    //     batchSize = 2 ** batch.depth;
    //     initialNormalisedBalance = batch.initialPaymentPerChunk;
    //     expectedNormalisedBalance = initialNormalisedBalance + topupAmountPerChunk;

    //     await token.mint(stamper, (batch.initialPaymentPerChunk + topupAmountPerChunk) * batchSize);
    //     (await ethers.getContract('TestToken', stamper)).approve(
    //       postageStamp.address,
    //       (batch.initialPaymentPerChunk + topupAmountPerChunk) * batchSize
    //     );
    //     await postageStamp.createBatch(
    //       stamper,
    //       batch.initialPaymentPerChunk,
    //       batch.depth,
    //       batch.bucketDepth,
    //       batch.nonce,
    //       batch.immutable
    //     );
    //   });

    //   it('should fire the BatchTopUp event', async function () {
    //     await expect(postageStamp.topUp(batch.id, topupAmountPerChunk))
    //       .to.emit(postageStamp, 'BatchTopUp')
    //       .withArgs(batch.id, topupAmountPerChunk * batchSize, expectedNormalisedBalance);
    //   });

    //   it('should update the normalised balance', async function () {
    //     await postageStamp.topUp(batch.id, topupAmountPerChunk);
    //     const stamp = await postageStamp.batches(batch.id);
    //     expect(stamp[3]).to.equal(expectedNormalisedBalance);
    //   });

    //   it('should transfer the token', async function () {
    //     await postageStamp.topUp(batch.id, topupAmountPerChunk);
    //     expect(await token.balanceOf(stamper)).to.equal(0);
    //     expect(await token.balanceOf(postageStamp.address)).to.equal(
    //       (batch.initialPaymentPerChunk + topupAmountPerChunk) * batchSize
    //     );
    //   });

    //   it('should not top up non-existing batches', async function () {
    //     const nonExistingBatchId = computeBatchId(deployer, batch.nonce);
    //     await expect(postageStamp.topUp(nonExistingBatchId, topupAmountPerChunk)).to.be.revertedWith(
    //       'batch does not exist'
    //     );
    //   });

    //   it('should not top up with insufficient funds', async function () {
    //     await expect(postageStamp.topUp(batch.id, topupAmountPerChunk + 1)).to.be.revertedWith(
    //       'ERC20: transfer amount exceeds balance'
    //     );
    //   });

    //   it('should not top up expired batches', async function () {
    //     await setPrice(batch.initialPaymentPerChunk);
    //     await expect(postageStamp.topUp(batch.id, topupAmountPerChunk)).to.be.revertedWith(
    //       'batch already expired'
    //     );
    //   });
    //   it('should not top up when paused', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', deployer);
    //     await postageStamp.pause();
    //     await expect(postageStamp.topUp(batch.id, topupAmountPerChunk)).to.be.revertedWith(
    //       'Pausable: paused'
    //     );
    //   });
    //   it('should keep batches ordered by normalisedBalance', async function () {
    //     // mint more tokens
    //     await token.mint(stamper, 100000000000);
    //     (await ethers.getContract('TestToken', stamper)).approve(postageStamp.address, 100000000000);
    //     const batch0 = computeBatchId(stamper, batch.nonce);
    //     expect(batch0).equal(await postageStamp.firstBatchId());

    //     // create 2nd batch
    //     const nonce1 = '0x0000000000000000000000000000000000000000000000000000000000001235';
    //     await postageStamp.createBatch(
    //       stamper,
    //       199,
    //       batch.depth,
    //       batch.bucketDepth,
    //       nonce1,
    //       batch.immutable
    //     );

    //     const batch1 = computeBatchId(stamper, nonce1);
    //     expect(batch1).equal(await postageStamp.firstBatchId());

    //     await postageStamp.topUp(batch1, 2);

    //     // this will return the previous batch id
    //     expect(batch0).equal(await postageStamp.firstBatchId());
    //   });
    // });

    // describe('when increasing the depth', function () {
    //   beforeEach(async function () {
    //     postageStamp = await ethers.getContract('PostageStamp', stamper);
    //     token = await ethers.getContract('TestToken', deployer);

    //     price = 100;
    //     totalOutPayment = price;

    //     batch = {
    //       nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
    //       initialPaymentPerChunk: 200000,
    //       depth: 17,
    //       bucketDepth: 16,
    //       immutable: false,
    //     };

    //     batch.id = computeBatchId(stamper, batch.nonce);
    //     newDepth = 18;

    //     batchSize = 2 ** batch.depth;
    //     newBatchSize = 2 ** newDepth;
    //     increaseFactor = newBatchSize / batchSize;
    //     initialNormalisedBalance = totalOutPayment + batch.initialPaymentPerChunk;
    //     const transferAmount = 2 * batch.initialPaymentPerChunk * batchSize;

    //     await token.mint(stamper, transferAmount);
    //     (await ethers.getContract('TestToken', stamper)).approve(postageStamp.address, transferAmount);

    //     await setPrice(price);
    //     // totalOutpayment: 0, pending: price
    //     await postageStamp.createBatch(
    //       stamper,
    //       batch.initialPaymentPerChunk,
    //       batch.depth,
    //       batch.bucketDepth,
    //       batch.nonce,
    //       batch.immutable
    //     );

    //     // at the moment of the depth increase the currentTotalOutpayment is already 2*price
    //     // 1 * price of the batch value was already used up
    //     expectedNormalisedBalance =
    //       2 * price + Math.floor((batch.initialPaymentPerChunk - price) / increaseFactor);
    //   });

    //   it('should fire the batch3epthIncrease event', async function () {
    //     await expect(postageStamp.increaseDepth(batch.id, newDepth))
    //       .to.emit(postageStamp, 'batch3epthIncrease')
    //       .withArgs(batch.id, newDepth, expectedNormalisedBalance);
    //   });

    //   it('should update the stamp data', async function () {
    //     await postageStamp.increaseDepth(batch.id, newDepth);
    //     const stamp = await postageStamp.batches(batch.id);
    //     expect(stamp[0]).to.equal(stamper);
    //     expect(stamp[1]).to.equal(newDepth);
    //     expect(stamp[2]).to.equal(batch.immutable);
    //     expect(stamp[3]).to.equal(expectedNormalisedBalance);
    //   });

    //   it('should not allow other accounts to increase depth', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', others[0]);
    //     await expect(postageStamp.increaseDepth(batch.id, newDepth)).to.be.revertedWith('not batch owner');
    //   });

    //   it('should not allow decreasing the depth', async function () {
    //     await expect(postageStamp.increaseDepth(batch.id, batch.depth - 1)).to.be.revertedWith(
    //       'depth not increasing'
    //     );
    //   });

    //   it('should not allow the same depth', async function () {
    //     await expect(postageStamp.increaseDepth(batch.id, batch.depth)).to.be.revertedWith(
    //       'depth not increasing'
    //     );
    //   });

    //   it('should not increase depth of expired batches', async function () {
    //     // one price applied so far, this ensures the currentTotalOutpayment will be exactly the batch value when increaseDepth is called
    //     await setPrice(batch.initialPaymentPerChunk - price);
    //     await expect(postageStamp.increaseDepth(batch.id, newDepth)).to.be.revertedWith(
    //       'batch already expired'
    //     );
    //   });

    //   it('should not increasing the detph when paused', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', deployer);
    //     await postageStamp.pause();
    //     await expect(postageStamp.increaseDepth(batch.id, newDepth)).to.be.revertedWith(
    //       'Pausable: paused'
    //     );
    //   });

    //   it('should compute correct balance if outpayments changed since creation', async function () {
    //     const newPrice = 64;
    //     await setPrice(newPrice);

    //     // at the moment of the depth increase the currentTotalOutpayment is already 2*price + 1*newPrice
    //     // 1 * price and 1 * newPrice of the batch value was already used up
    //     const expectedNormalisedBalance =
    //       2 * price +
    //       newPrice +
    //       Math.floor((batch.initialPaymentPerChunk - price - newPrice) / increaseFactor);

    //     await expect(postageStamp.increaseDepth(batch.id, newDepth))
    //       .to.emit(postageStamp, 'batch3epthIncrease')
    //       .withArgs(batch.id, newDepth, expectedNormalisedBalance);
    //   });

    //   it('should keep batches ordered by normalisedBalance', async function () {
    //     // compute batch A, which should match lowest batch from firstBatchId()
    //     const batch0 = computeBatchId(stamper, batch.nonce);
    //     let value = await postageStamp.firstBatchId();
    //     expect(value).equal(batch0);

    //     // mint more tokens
    //     await token.mint(stamper, 100000000000);
    //     (await ethers.getContract('TestToken', stamper)).approve(postageStamp.address, 100000000000);

    //     const nonce1 = '0x0000000000000000000000000000000000000000000000000000000000001234';
    //     await postageStamp.createBatch(
    //       stamper,
    //       batch.initialPaymentPerChunk / 2,
    //       batch.depth,
    //       batch.bucketDepth,
    //       nonce1,
    //       batch.immutable
    //     );
    //     const batch1 = computeBatchId(stamper, nonce1);

    //     // lowest should be last added batch with balance = batch.initialPaymentPerChunk / 2
    //     value = await postageStamp.firstBatchId();
    //     expect(value).equal(batch1);

    //     // increase depth to previous batch id
    //     await postageStamp.increaseDepth(batch0, 18);

    //     // lowest batch id is the one with increased depth
    //     value = await postageStamp.firstBatchId();
    //     expect(value).equal(batch0);
    //   });

    //   it('should delete expired batches', async function () {
    //     const price = 1;
    //     await setPrice(price);

    //     const initialExpectedPot = price * 2 ** batch.depth + price * 2 ** batch.depth;
    //     let numberOfBatches = 1;
    //     let newBlocks = 0;
    //     let expectedPot = initialExpectedPot;

    //     const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
    //     await postageStamp.createBatch(
    //       stamper,
    //       8,
    //       batch.depth,
    //       batch.bucketDepth,
    //       nonce0,
    //       batch.immutable
    //     );
    //     const batch0 = computeBatchId(stamper, nonce0);
    //     expect(batch0).equal(await postageStamp.firstBatchId());

    //     expect(await postageStamp.pot()).equal(expectedPot);

    //     numberOfBatches++;
    //     newBlocks = 1;

    //     const nonce1 = '0x0000000000000000000000000000000000000000000000000000000000001235';
    //     await postageStamp.createBatch(
    //       stamper,
    //       3,
    //       batch.depth,
    //       batch.bucketDepth,
    //       nonce1,
    //       batch.immutable
    //     );
    //     const batch1 = computeBatchId(stamper, nonce1);
    //     expect(batch1).equal(await postageStamp.firstBatchId());

    //     expectedPot += numberOfBatches * newBlocks * 2 ** batch.depth;
    //     expect(await postageStamp.pot()).equal(expectedPot);

    //     numberOfBatches++;
    //     newBlocks = 1;

    //     const nonce2 = '0x0000000000000000000000000000000000000000000000000000000000001236';
    //     await postageStamp.createBatch(
    //       stamper,
    //       7,
    //       batch.depth,
    //       batch.bucketDepth,
    //       nonce2,
    //       batch.immutable
    //     );
    //     const batch2 = computeBatchId(stamper, nonce2);
    //     expect(batch1).equal(await postageStamp.firstBatchId());
    //     expect(batch2).not.equal(await postageStamp.firstBatchId());

    //     const stamp = await postageStamp.batches(batch1);
    //     expect(stamp[0]).to.equal(stamper);
    //     expect(stamp[1]).to.equal(batch.depth);
    //     expect(stamp[2]).to.equal(batch.immutable);
    //     expect(stamp[3]).to.equal(205);

    //     expectedPot += numberOfBatches * newBlocks * 2 ** batch.depth;
    //     expect(await postageStamp.pot()).equal(expectedPot);

    //     numberOfBatches++;
    //     newBlocks = 1;

    //     await mineNBlocks(2);
    //     newBlocks = 3;

    //     expect(await postageStamp.pot()).equal(expectedPot);

    //     expect(batch1).equal(await postageStamp.firstBatchId());

    //     await postageStamp.increaseDepth(batch2, batch.depth + 1);

    //     const expiredEarlier = 1;

    //     expectedPot += (numberOfBatches * newBlocks - expiredEarlier) * 2 ** batch.depth;
    //     expect(await postageStamp.pot()).equal(expectedPot);

    //     expect(batch1).not.equal(await postageStamp.firstBatchId());
    //     expect(batch2).equal(await postageStamp.firstBatchId());
    //   });
    // });

    // describe('when increasing the depth of immutable batches', function () {
    //   beforeEach(async function () {
    //     postageStamp = await ethers.getContract('PostageStamp', stamper);
    //     token = await ethers.getContract('TestToken', deployer);

    //     price = 100;
    //     totalOutPayment = price;

    //     batch = {
    //       nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
    //       initialPaymentPerChunk: 200000,
    //       depth: 17,
    //       bucketDepth: 16,
    //       immutable: true,
    //     };

    //     batch.id = computeBatchId(stamper, batch.nonce);
    //     newDepth = 10;

    //     batchSize = 2 ** batch.depth;
    //     const transferAmount = batch.initialPaymentPerChunk * batchSize;

    //     await token.mint(stamper, transferAmount);
    //     (await ethers.getContract('TestToken', stamper)).approve(postageStamp.address, transferAmount);

    //     await setPrice(price);
    //     // totalOutpayment: 0, pending: price
    //     await postageStamp.createBatch(
    //       stamper,
    //       batch.initialPaymentPerChunk,
    //       batch.depth,
    //       batch.bucketDepth,
    //       batch.nonce,
    //       batch.immutable
    //     );
    //   });

    //   it('should revert', async function () {
    //     await expect(postageStamp.increaseDepth(batch.id, newDepth)).to.be.revertedWith(
    //       'batch is immutable'
    //     );
    //   });
    // });

    // describe('when setting the price', function () {
    //   it('should increase the outpayment if called by oracle', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', oracle);

    //     const price1 = 2048;
    //     await postageStamp.setPrice(price1);

    //     await ethers.provider.send('evm_mine', []);
    //     expect(await postageStamp.currentTotalOutPayment()).to.be.eq(price1);

    //     await ethers.provider.send('evm_mine', []);
    //     expect(await postageStamp.currentTotalOutPayment()).to.be.eq(2 * price1);

    //     const price2 = 4096;
    //     await postageStamp.setPrice(price2);
    //     expect(await postageStamp.currentTotalOutPayment()).to.be.eq(3 * price1);

    //     await ethers.provider.send('evm_mine', []);
    //     expect(await postageStamp.currentTotalOutPayment()).to.be.eq(3 * price1 + 1 * price2);

    //     await ethers.provider.send('evm_mine', []);
    //     expect(await postageStamp.currentTotalOutPayment()).to.be.eq(3 * price1 + 2 * price2);
    //   });

    //   it('should emit event if called by oracle', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', oracle);
    //     const price = 2048;
    //     await expect(postageStamp.setPrice(price)).to.emit(postageStamp, 'PriceUpdate').withArgs(price);
    //   });

    //   it('should revert if not called by oracle', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', deployer);
    //     await expect(postageStamp.setPrice(100)).to.be.revertedWith('only price oracle can set the price');
    //   });
    // });

    // describe('when pausing', function () {
    //   it('should not allow anybody but the pauser to pause', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', stamper);
    //     await expect(postageStamp.pause()).to.be.revertedWith('only pauser can pause');
    //   });
    // });

    // describe('when unpausing', function () {
    //   it('should unpause when pause and then unpause', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', deployer);
    //     await postageStamp.pause();
    //     await postageStamp.unPause();
    //     expect(await postageStamp.paused()).to.be.false;
    //   });

    //   it('should not allow anybody but the pauser to unpause', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', deployer);
    //     await postageStamp.pause();
    //     const postageStamp2 = await ethers.getContract('PostageStamp', stamper);
    //     await expect(postageStamp2.unPause()).to.be.revertedWith('only pauser can unpause');
    //   });

    //   it('should not allow unpausing when not paused', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', deployer);
    //     await expect(postageStamp.unPause()).to.be.revertedWith('Pausable: not paused');
    //   });
    // });

    // describe('when getting remaining balance', function () {
    //   it('should revert if the batch does not exist', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', deployer);
    //     await expect(
    //       postageStamp.remainingBalance('0x000000000000000000000000000000000000000000000000000000000000abcd')
    //     ).to.be.revertedWith('batch does not exist');
    //   });
    // });

    // describe('when redistributor withdraws pot', function () {
    //   let receiver: Signer;
    //   let beneficiary: Signer;

    //   beforeEach(async function () {
    //     const accounts = await ethers.getSigners();
    //     receiver = accounts[0];
    //     beneficiary = accounts[1];
    //     postageStamp = await ethers.getContract('PostageStamp', stamper);
    //     token = await ethers.getContract('TestToken', deployer);

    //     batch = {
    //       nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
    //       initialPaymentPerChunk: 20480,
    //       depth: 17,
    //       immutable: false,
    //       bucketDepth: 16,
    //     };

    //     batchSize = 2 ** batch.depth;
    //     transferAmount = 2 * batch.initialPaymentPerChunk * batchSize;
    //     expectedNormalisedBalance = batch.initialPaymentPerChunk;

    //     batch.id = computeBatchId(stamper, batch.nonce);

    //     await token.mint(stamper, transferAmount);
    //     (await ethers.getContract('TestToken', stamper)).approve(postageStamp.address, transferAmount);
    //   });
    //   it('should transfer the pot to the redistributor', async function () {
    //     const price = 2048;
    //     await setPrice(price);

    //     const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
    //     await postageStamp.createBatch(
    //       stamper,
    //       batch.initialPaymentPerChunk,
    //       batch.depth,
    //       batch.bucketDepth,
    //       nonce0,
    //       batch.immutable
    //     );
    //     const batch0 = computeBatchId(stamper, nonce0);
    //     expect(batch0).equal(await postageStamp.firstBatchId());

    //     expect(await postageStamp.pot()).equal(0 * 2 ** batch.depth);

    //     await mineNBlocks(10);

    //     const postageStamp = await ethers.getContract('PostageStamp', deployer);

    //     const redistributorRole = await postageStamp.REDISTRIBUTOR_ROLE();
    //     await postageStamp.grantRole(redistributorRole, receiver.getAddress());

    //     const numberOfNewBlocks = 12;

    //     const expectedAmount = numberOfNewBlocks * price * 2 ** batch.depth;

    //     await expect(postageStamp.connect(receiver).withdraw(beneficiary.getAddress()));

    //     expect(await token.balanceOf(beneficiary.getAddress())).to.equal(expectedAmount);
    //   });
    // });

    // describe('when expireLimited is called', function () {
    //   beforeEach(async function () {
    //     postageStamp = await ethers.getContract('PostageStamp', stamper);
    //     token = await ethers.getContract('TestToken', deployer);

    //     batch = {
    //       nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
    //       initialPaymentPerChunk: 4096,
    //       depth: 17,
    //       immutable: false,
    //       bucketDepth: 16,
    //     };

    //     batchSize = 2 ** batch.depth;
    //     transferAmount = 2 * batch.initialPaymentPerChunk * batchSize;
    //     expectedNormalisedBalance = batch.initialPaymentPerChunk;

    //     batch.id = computeBatchId(stamper, batch.nonce);

    //     await token.mint(stamper, transferAmount);
    //     (await ethers.getContract('TestToken', stamper)).approve(postageStamp.address, transferAmount);
    //   });
    //   it('should update the pot and delete expired batches', async function () {
    //     const price = 2048;
    //     await setPrice(price);

    //     const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
    //     await postageStamp.createBatch(
    //       stamper,
    //       4096,
    //       batch.depth,
    //       batch.bucketDepth,
    //       nonce0,
    //       batch.immutable
    //     );
    //     const batch0 = computeBatchId(stamper, nonce0);
    //     expect(batch0).equal(await postageStamp.firstBatchId());

    //     //        expect(await postageStamp.pot()).equal(0 * 2 ** batch.depth);
    //     expect(await postageStamp.hasExpired()).equal(false);
    //     await mineNBlocks(10);
    //     expect(await postageStamp.hasExpired()).equal(true);

    //     const expectedAmount = 100 * 2 ** batch.depth;

    //     expect(await postageStamp.expireLimited(1));

    //     expect(await postageStamp.pot()).equal(expectedAmount);
    //     expect(await postageStamp.hasExpired()).equal(false);
    //   });
    // });

    // describe('when topupPot is called', function () {
    //   beforeEach(async function () {
    //     postageStamp = await ethers.getContract('PostageStamp', stamper);
    //     token = await ethers.getContract('TestToken', deployer);

    //     transferAmount = 2 ** 20;

    //     await token.mint(stamper, transferAmount);
    //     (await ethers.getContract('TestToken', stamper)).approve(postageStamp.address, transferAmount);
    //   });
    //   it('should add to pot', async function () {
    //     const expectedAmount = transferAmount;

    //     expect(await postageStamp.pot()).equal(0);

    //     expect(await postageStamp.topupPot(transferAmount));

    //     expect(await postageStamp.pot()).equal(expectedAmount);
    //   });
    // });

    // describe('when batch depth limit changes', function () {
    //   let receiver: Signer;
    //   beforeEach(async function () {
    //     const accounts = await ethers.getSigners();
    //     receiver = accounts[0];
    //     postageStamp = await ethers.getContract('PostageStamp', stamper);
    //     token = await ethers.getContract('TestToken', deployer);

    //     batch = {
    //       nonce: '0x000000000000000000000000000000000000000000000000000000000000abcd',
    //       initialPaymentPerChunk: 10240,
    //       depth: 17,
    //       immutable: false,
    //       bucketDepth: 16,
    //     };

    //     batchSize = 2 ** batch.depth;
    //     transferAmount = 200 * 2 * batch.initialPaymentPerChunk * batchSize;
    //     expectedNormalisedBalance = batch.initialPaymentPerChunk;

    //     batch.id = computeBatchId(stamper, batch.nonce);

    //     await token.mint(stamper, transferAmount);
    //     (await ethers.getContract('TestToken', stamper)).approve(postageStamp.address, transferAmount);
    //   });
    //   it('should not allow creating a small batch', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', deployer);
    //     const updaterRole = await postageStamp.DEPTH_ORACLE_ROLE();

    //     await postageStamp.grantRole(updaterRole, receiver.getAddress());

    //     const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
    //     await postageStamp.createBatch(
    //       stamper,
    //       10240,
    //       batch.depth,
    //       batch.bucketDepth,
    //       nonce0,
    //       batch.immutable
    //     );
    //     const batch0 = computeBatchId(stamper, nonce0);
    //     expect(batch0).equal(await postageStamp.firstBatchId());

    //     await mineNBlocks(10);

    //     expect(await postageStamp.connect(receiver).setMinimumbatch3epth(17));

    //     const nonce1 = '0x0000000000000000000000000000000000000000000000000000000000001235';

    //     await expect(
    //       postageStamp.createBatch(
    //         stamper,
    //         10240,
    //         batch.depth,
    //         batch.bucketDepth,
    //         nonce1,
    //         batch.immutable
    //       )
    //     ).to.be.revertedWith('invalid bucket depth');
    //   });

    //   it('should not allow topping up a small batch', async function () {
    //     const postageStamp = await ethers.getContract('PostageStamp', deployer);
    //     const updaterRole = await postageStamp.DEPTH_ORACLE_ROLE();

    //     await postageStamp.grantRole(updaterRole, receiver.getAddress());

    //     const nonce0 = '0x0000000000000000000000000000000000000000000000000000000000001234';
    //     await postageStamp.createBatch(
    //       stamper,
    //       10240,
    //       batch.depth,
    //       batch.bucketDepth,
    //       nonce0,
    //       batch.immutable
    //     );
    //     const batch0 = computeBatchId(stamper, nonce0);
    //     expect(batch0).equal(await postageStamp.firstBatchId());

    //     await mineNBlocks(10);

    //     expect(await postageStamp.connect(receiver).setMinimumbatch3epth(20));

    //     await expect(postageStamp.topUp(batch0, 100)).to.be.revertedWith('batch too small to renew');

    //     await expect(postageStamp.increaseDepth(batch0, 18)).to.be.revertedWith('depth not increasing');

    //     expect(await postageStamp.increaseDepth(batch0, 21));

    //     expect(await postageStamp.topUp(batch0, 100));
    //   });
    // });
  });
});
