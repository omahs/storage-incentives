// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.1;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
// import "hardhat/console.sol";

/**
 * @title PostageStaking contract
 * @author The Swarm Authors
 * @dev The postage stamp contracts allows users to create and manage postage stamp batches.
 */
contract StakeRegistry is AccessControl, Pausable {

    /**
     * @dev Emitted when a new batch is created.
     */
    event StakeUpdated(
        bytes32 indexed overlay,
        uint256 stakeAmount,
        address owner,
        uint256 lastUpdatedBlock
    );

    struct Stake {
        //
        bytes32 overlay;
        //
        uint256 stakeAmount;
        //
        address owner;
        //
        uint256 lastUpdatedBlockNumber;
        //
        bool isValue;
    }

    // The role allowed to pause
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    // The role allowed to freeze and slash entries
    bytes32 public constant REDISTRIBUTOR_ROLE = keccak256("REDISTRIBUTOR_ROLE");

    uint8 NetworkId;

    // Associate every stake id with overlay data.
    mapping(bytes32 => Stake) public stakes;

    address public bzzToken;

    uint256 public pot;

    /**
     * @param _bzzToken The ERC20 token address to reference in this contract.
     */
    constructor(address _bzzToken, uint8 _NetworkId) {
        NetworkId = _NetworkId;
        bzzToken = _bzzToken;
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PAUSER_ROLE, msg.sender);
    }

    function overlayNotFrozen(bytes32 overlay) internal view returns (bool) {
        return stakes[overlay].lastUpdatedBlockNumber < block.number;
    }

    function stakeOfOverlay(bytes32 overlay) public view returns (uint256) {
        return overlayNotFrozen(overlay) ? stakes[overlay].stakeAmount : 0;
    }

    function lastUpdatedBlockNumberOfOverlay(bytes32 overlay) public view returns(uint256) {
        return stakes[overlay].lastUpdatedBlockNumber;
    }

    function ownerOfOverlay(bytes32 overlay) public view returns (address) {
        return stakes[overlay].owner;
    }

    /**
     * @notice Create a new stake or update an existing one.
     * @dev At least `_initialBalancePerChunk*2^depth` number of tokens need to be preapproved for this contract.
     * @param _owner eth address used for overlay calculation
     * @param nonce used for overlay calculation
     * @param amount deposited amount
     */
    function depositStake(
        address _owner,
        bytes32 nonce,
        uint256 amount
    ) external whenNotPaused {
        require(_owner != address(0), "owner cannot be the zero address");

        bytes32 overlay = keccak256(abi.encodePacked(_owner, NetworkId, nonce));
        uint256 updatedAmount = amount;

        if (stakes[overlay].isValue) {
            require(overlayNotFrozen(overlay), "overlay currently frozen");
            updatedAmount = amount + stakes[overlay].stakeAmount;
        }

        require(ERC20(bzzToken).transferFrom(msg.sender, address(this), amount), "failed transfer");

        emit StakeUpdated(overlay, updatedAmount, _owner, block.number);

        stakes[overlay] = Stake({
            owner: _owner,
            overlay: overlay,
            stakeAmount: updatedAmount,
            lastUpdatedBlockNumber: block.number,
            isValue: true
        });
    }

    /*
     * @notice freeze an existing stake
     * @dev can only be called by the redistributor
     * @param overlay the overlay selected
     * @param time penalty length in blocknumbers
     */
    function freezeDeposit(bytes32 overlay, uint256 time) external {
        require(hasRole(REDISTRIBUTOR_ROLE, msg.sender), "only redistributor can freeze stake");

        if ( stakes[overlay].isValue ) {
            stakes[overlay].lastUpdatedBlockNumber = block.number + time;
        }
    }

    /**
     * @notice slash and redistribute an existing stake
     * @dev can only be called by the redistributor
     * @param overlay the overlay selected
     */
    function slashDeposit(bytes32 overlay) external {
        require(hasRole(REDISTRIBUTOR_ROLE, msg.sender), "only redistributor can slash stake");
        if ( stakes[overlay].isValue ) {
            // pot.topupPot(stakes[overlay].stakeAmount)
            // pot -= stakes[overlay].stakeAmount
            delete stakes[overlay];
        }
    }

    /**
     * @notice Pause the contract. The contract is provably stopped by renouncing the pauser role and the admin role after pausing
     * @dev can only be called by the pauser when not paused
     */
    function pause() public {
        require(hasRole(PAUSER_ROLE, msg.sender), "only pauser can pause the contract");
        _pause();
    }

    /**
     * @notice Unpause the contract.
     * @dev can only be called by the pauser when paused
     */
    function unPause() public {
        require(hasRole(PAUSER_ROLE, msg.sender), "only pauser can unpause the contract");
        _unpause();
    }

    // stoppable ?
}