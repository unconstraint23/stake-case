const { ethers, upgrades } = require("hardhat");
const { expect } = require("chai");

describe("MetaNode Token and Stake Contract Complete Test", function () {
  let MetaNodeToken, MetaNodeStake;
  let owner, user1, user2, user3;
  let metaNodeToken, metaNodeStake;

  beforeEach(async function () {
    [owner, user1, user2, user3] = await ethers.getSigners();

    // 部署 MetaNode 代币
    MetaNodeToken = await ethers.getContractFactory("MetaNodeToken");
    metaNodeToken = await MetaNodeToken.deploy();
    await metaNodeToken.waitForDeployment();

    // 部署 MetaNodeStake 合约
    MetaNodeStake = await ethers.getContractFactory("MetaNodeStake");
    metaNodeStake = await upgrades.deployProxy(
      MetaNodeStake,
      [
        await metaNodeToken.getAddress(),
        100, // startBlock
        100000000, // endBlock
        ethers.parseEther("3") // MetaNodePerBlock
      ],
      { initializer: "initialize" }
    );
    await metaNodeStake.waitForDeployment();

    // 转移代币到质押合约
    const totalSupply = await metaNodeToken.totalSupply();

    const keepForOwner = ethers.parseEther("200000");
    const toUser1 = ethers.parseEther("10000");
    const toUser2 = ethers.parseEther("10000");
    await metaNodeToken.transfer(user1.address, toUser1);
    await metaNodeToken.transfer(user2.address, toUser2)
    const toStake = totalSupply - keepForOwner - toUser1 - toUser2;
    if (toStake < 0n) {
      throw new Error("toStake became negative — check totalSupply and keepForOwner values");
    }


    await metaNodeToken.transfer(await metaNodeStake.getAddress(), toStake);
    console.log("totalSupply", totalSupply.toString());
    console.log("ownerBalance", (await metaNodeToken.balanceOf(owner.address)).toString());
    console.log("stakeBalance", (await metaNodeToken.balanceOf(await metaNodeStake.getAddress())).toString());
    console.log("user1Balance", (await metaNodeToken.balanceOf(user1.address)).toString());
    console.log("user2Balance", (await metaNodeToken.balanceOf(user2.address)).toString());
  });

  describe("MetaNode Token Tests", function () {
    it("Should have correct initial supply", async function () {
      const totalSupply = await metaNodeToken.totalSupply();
      expect(totalSupply).to.equal(ethers.parseEther("10000000"));
    });

    it("Should transfer tokens correctly", async function () {
      const transferAmount = ethers.parseEther("1000");
      await metaNodeToken.transfer(user1.address, transferAmount);
      
      const user1Balance = await metaNodeToken.balanceOf(user1.address);
      expect(user1Balance).to.equal(ethers.parseEther("10000") + transferAmount);
    });

    it("Should approve and transferFrom correctly", async function () {
      const approveAmount = ethers.parseEther("500");
      // owner approve user1
      await metaNodeToken.approve(user1.address, approveAmount);

      const allowance = await metaNodeToken.allowance(owner.address, user1.address);
      expect(allowance).to.equal(approveAmount);

      // user1 使用 allowance 从 owner 转给 user2，验证是否是erc20 兼容性测试
      await metaNodeToken.connect(user1).transferFrom(owner.address, user2.address, approveAmount);
      const user2Balance = await metaNodeToken.balanceOf(user2.address);
      expect(user2Balance).to.equal(ethers.parseEther("10000") + approveAmount);
    });
  });

  describe("MetaNodeStake Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      const metaNodeAddress = await metaNodeStake.MetaNode();
      const startBlock = await metaNodeStake.startBlock();
      const endBlock = await metaNodeStake.endBlock();
      const metaNodePerBlock = await metaNodeStake.MetaNodePerBlock();

      expect(metaNodeAddress).to.equal(await metaNodeToken.getAddress());
      expect(startBlock).to.equal(100);
      expect(endBlock).to.equal(100000000);
      expect(metaNodePerBlock).to.equal(ethers.parseEther("3"));
    });
  });

  describe("Pool Management", function () {
    it("Should add ETH pool correctly", async function () {
      await metaNodeStake.addPool(
        ethers.ZeroAddress, // ETH pool
        500, // poolWeight
        ethers.parseEther("0.1"), // minDepositAmount
        20, // unstakeLockedBlocks
        true // withUpdate
      );

      const pool = await metaNodeStake.pool(0);
      expect(pool.stTokenAddress).to.equal(ethers.ZeroAddress);
      expect(pool.poolWeight).to.equal(500);
      expect(pool.minDepositAmount).to.equal(ethers.parseEther("0.1"));
      expect(pool.unstakeLockedBlocks).to.equal(20);
    });

    it("Should only allow admin to add pools", async function () {
      await expect(
        metaNodeStake.connect(user1).addPool(
          ethers.ZeroAddress,
          500,
          ethers.parseEther("0.1"),
          20,
          true
        )
      ).to.be.reverted;
    });

    it("Should update pool weight correctly", async function () {
      await metaNodeStake.addPool(ethers.ZeroAddress, 500, ethers.parseEther("0.1"), 20, true);
      
      const initialWeight = await metaNodeStake.totalPoolWeight();
      await metaNodeStake.setPoolWeight(0, 800, false);
      
      const pool = await metaNodeStake.pool(0);
      const newTotalWeight = await metaNodeStake.totalPoolWeight();
      
      expect(pool.poolWeight).to.equal(800);
      expect(newTotalWeight).to.equal(initialWeight - 500n + 800n);
    });
  });

  describe("ETH Staking", function () {
    beforeEach(async function () {
      // 添加ETH池
      await metaNodeStake.addPool(ethers.ZeroAddress, 500, ethers.parseEther("0.1"), 20, true);
    });

    it("Should deposit ETH correctly", async function () {
      const depositAmount = ethers.parseEther("1");
      const initialContractBalance = await ethers.provider.getBalance(await metaNodeStake.getAddress());
      
      await metaNodeStake.depositETH({ value: depositAmount });
      
      const userInfo = await metaNodeStake.user(0, owner.address);
      const contractBalance = await ethers.provider.getBalance(await metaNodeStake.getAddress());
      
      expect(userInfo.stAmount).to.equal(depositAmount);
      expect(contractBalance).to.equal(initialContractBalance + depositAmount);
    });

    it("Should reject deposit below minimum amount", async function () {
      const smallAmount = ethers.parseEther("0.05"); // 小于最小质押金额
      
      await expect(
        metaNodeStake.depositETH({ value: smallAmount })
      ).to.be.revertedWith("deposit amount is too small");
    });

    it("Should handle multiple deposits correctly", async function () {
      const deposit1 = ethers.parseEther("1");
      const deposit2 = ethers.parseEther("2");
      
      await metaNodeStake.depositETH({ value: deposit1 });
      await metaNodeStake.depositETH({ value: deposit2 });
      
      const userInfo = await metaNodeStake.user(0, owner.address);
      expect(userInfo.stAmount).to.equal(deposit1 + deposit2);
    });
  });

  describe("Unstaking and Withdrawal", function () {
    beforeEach(async function () {
      await metaNodeStake.addPool(ethers.ZeroAddress, 500, ethers.parseEther("0.1"), 20, true);
      await metaNodeStake.depositETH({ value: ethers.parseEther("1") });
    });

    it("Should unstake correctly", async function () {
      const unstakeAmount = ethers.parseEther("0.5");

      // 确保已经到 startBlock 以后
      let currentBlock = await ethers.provider.getBlockNumber();

      while (currentBlock < 100) {
        await ethers.provider.send("evm_mine", []);
        currentBlock++;
      }

      // 解押
      await metaNodeStake.unstake(0, unstakeAmount);

      // 推进区块
      for (let i = 0; i < 50; i++) {
        await ethers.provider.send("evm_mine", []);
      }

      // 触发一次交互来更新奖励
      await metaNodeStake.depositETH({ value: 0 });

      const userInfo = await metaNodeStake.user(0, owner.address);
      expect(userInfo.stAmount).to.equal(ethers.parseEther("0.5"));
      expect(userInfo.pendingMetaNode).to.be.gt(0);
    });

    it("Should not allow unstaking more than staked", async function () {
      const excessAmount = ethers.parseEther("2");
      
      await expect(
        metaNodeStake.unstake(0, excessAmount)
      ).to.be.revertedWith("Not enough staking token balance");
    });

    it("Should withdraw after lock period", async function () {
      const unstakeAmount = ethers.parseEther("0.5");
      await metaNodeStake.unstake(0, unstakeAmount);
      
      // 推进区块超过锁定期
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);
      // ... 推进更多区块直到超过20个区块
      for (let i = 0; i < 25; i++) {
        await ethers.provider.send("evm_mine", []);
      }
      
      const initialBalance = await ethers.provider.getBalance(owner.address);
      await metaNodeStake.withdraw(0);
      const finalBalance = await ethers.provider.getBalance(owner.address);
      
      expect(finalBalance).to.be.gt(initialBalance);
    });

    it("Should not allow withdrawal before lock period", async function () {
      const unstakeAmount = ethers.parseEther("0.5");
      await metaNodeStake.unstake(0, unstakeAmount);
      
      // 只推进几个区块，未超过锁定期
      for (let i = 0; i < 10; i++) {
        await ethers.provider.send("evm_mine", []);
      }
      
      const withdrawAmount = await metaNodeStake.withdrawAmount(0, owner.address);
      expect(withdrawAmount.pendingWithdrawAmount).to.equal(0);
    });
  });

  describe("Reward System", function () {
    beforeEach(async function () {
      await metaNodeStake.addPool(ethers.ZeroAddress, 500, ethers.parseEther("0.1"), 20, true);
      await metaNodeStake.depositETH({ value: ethers.parseEther("1") });
    });

    it("Should calculate pending rewards correctly", async function () {
      // 推进区块以产生奖励
      for (let i = 0; i < 100; i++) {
        await ethers.provider.send("evm_mine", []);
      }
      
      const pendingReward = await metaNodeStake.pendingMetaNode(0, owner.address);
      expect(pendingReward).to.be.gt(0);
    });

    it("Should claim rewards correctly", async function () {
      // 推进区块产生奖励
      for (let i = 0; i < 100; i++) {
        await ethers.provider.send("evm_mine", []);
      }
      
      const initialBalance = await metaNodeToken.balanceOf(owner.address);
      await metaNodeStake.claim(0);
      const finalBalance = await metaNodeToken.balanceOf(owner.address);
      
      expect(finalBalance).to.be.gt(initialBalance);
    });

    it("Should accumulate rewards over time", async function () {
      const initialReward = await metaNodeStake.pendingMetaNode(0, owner.address);
      
      // 推进更多区块
      for (let i = 0; i < 50; i++) {
        await ethers.provider.send("evm_mine", []);
      }
      
      const laterReward = await metaNodeStake.pendingMetaNode(0, owner.address);
      expect(laterReward).to.be.gt(initialReward);
    });
  });

  describe("Access Control", function () {
    it("Should only allow admin to pause functions", async function () {
      await expect(
        metaNodeStake.connect(user1).pauseWithdraw()
      ).to.be.reverted;
      
      await expect(
        metaNodeStake.connect(user1).pauseClaim()
      ).to.be.reverted;
    });

    it("Should allow admin to pause and unpause", async function () {
      await metaNodeStake.pauseWithdraw();
      expect(await metaNodeStake.withdrawPaused()).to.be.true;
      
      await metaNodeStake.unpauseWithdraw();
      expect(await metaNodeStake.withdrawPaused()).to.be.false;
    });

    it("Should prevent operations when paused", async function () {
      await metaNodeStake.addPool(ethers.ZeroAddress, 500, ethers.parseEther("0.1"), 20, true);
      await metaNodeStake.depositETH({ value: ethers.parseEther("1") });
      
      await metaNodeStake.pauseWithdraw();
      
      await expect(
        metaNodeStake.unstake(0, ethers.parseEther("0.5"))
      ).to.be.revertedWith("withdraw is paused");
    });
  });

  describe("Edge Cases", function () {
    beforeEach(async function () {
      await metaNodeStake.addPool(ethers.ZeroAddress, 500, ethers.parseEther("0.1"), 20, true);
    });

    it("Should handle zero amount deposits", async function () {
      await expect(
        metaNodeStake.depositETH({ value: 0 })
      ).to.be.revertedWith("deposit amount is too small");
    });

    it("Should handle zero amount unstaking", async function () {
      await metaNodeStake.depositETH({ value: ethers.parseEther("1") });
      
      // 零金额解押应该成功但不改变状态
      const userInfoBefore = await metaNodeStake.user(0, owner.address);
      await metaNodeStake.unstake(0, 0);
      const userInfoAfter = await metaNodeStake.user(0, owner.address);
      
      expect(userInfoAfter.stAmount).to.equal(userInfoBefore.stAmount);
    });

    it("Should handle multiple users correctly", async function () {
      // 用户1质押
      await metaNodeStake.connect(user1).depositETH({ value: ethers.parseEther("1") });
      
      // 用户2质押
      await metaNodeStake.connect(user2).depositETH({ value: ethers.parseEther("2") });
      
      // 推进区块产生奖励
      for (let i = 0; i < 100; i++) {
        await ethers.provider.send("evm_mine", []);
      }
      
      const user1Reward = await metaNodeStake.pendingMetaNode(0, user1.address);
      const user2Reward = await metaNodeStake.pendingMetaNode(0, user2.address);
      
      // 用户2质押更多，应该获得更多奖励
      expect(user2Reward).to.be.gt(user1Reward);
    });
  });

  describe("Gas Optimization", function () {
    it("Should handle large number of unstake requests efficiently", async function () {
      await metaNodeStake.addPool(ethers.ZeroAddress, 500, ethers.parseEther("0.1"), 20, true);
      await metaNodeStake.depositETH({ value: ethers.parseEther("10") });
      
      // 创建多个解押请求
      for (let i = 0; i < 5; i++) {
        await metaNodeStake.unstake(0, ethers.parseEther("1"));
      }
      
      const userInfo = await metaNodeStake.user(0, owner.address);
      expect(userInfo.stAmount).to.equal(ethers.parseEther("5"));
    });
  });

  describe("Integration Tests", function () {
    it("Should complete full staking cycle", async function () {
      // 1. 添加池
      await metaNodeStake.addPool(ethers.ZeroAddress, 500, ethers.parseEther("0.1"), 20, true);
      
      // 2. 质押
      await metaNodeStake.depositETH({ value: ethers.parseEther("1") });
      
      // 3. 等待产生奖励
      for (let i = 0; i < 100; i++) {
        await ethers.provider.send("evm_mine", []);
      }
      
      // 4. 领取奖励
      const initialBalance = await metaNodeToken.balanceOf(owner.address);
      await metaNodeStake.claim(0);
      const afterClaimBalance = await metaNodeToken.balanceOf(owner.address);
      expect(afterClaimBalance).to.be.gt(initialBalance);
      
      // 5. 解押
      await metaNodeStake.unstake(0, ethers.parseEther("0.5"));
      
      // 6. 等待锁定期
      for (let i = 0; i < 25; i++) {
        await ethers.provider.send("evm_mine", []);
      }
      
      // 7. 提取
      const initialEthBalance = await ethers.provider.getBalance(owner.address);
      await metaNodeStake.withdraw(0);
      const finalEthBalance = await ethers.provider.getBalance(owner.address);
      expect(finalEthBalance).to.be.gt(initialEthBalance);
    });
  });
});
