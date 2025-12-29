// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice Reference debit wallet implementation for ODP deferred payments.
/// @dev This contract is for specification reference only and is not audited.
contract DebitWallet {
    struct WithdrawRequest {
        uint256 amount;
        uint256 requestedAt;
    }

    uint256 public immutable withdrawDelaySeconds;

    mapping(address => mapping(address => uint256)) private balances;
    mapping(address => mapping(address => WithdrawRequest)) private withdrawRequests;

    event Deposited(address indexed owner, address indexed asset, uint256 amount);
    event WithdrawRequested(address indexed owner, address indexed asset, uint256 amount, uint256 requestedAt);
    event Withdrawn(address indexed owner, address indexed asset, uint256 amount);

    constructor(uint256 withdrawDelaySeconds_) {
        withdrawDelaySeconds = withdrawDelaySeconds_;
    }

    function deposit(address asset, uint256 amount) external {
        require(amount > 0, "amount_zero");
        require(IERC20(asset).transferFrom(msg.sender, address(this), amount), "transfer_failed");
        balances[msg.sender][asset] += amount;
        emit Deposited(msg.sender, asset, amount);
    }

    function requestWithdraw(address asset, uint256 amount) external {
        require(amount > 0, "amount_zero");
        require(balances[msg.sender][asset] >= amount, "insufficient_balance");
        withdrawRequests[msg.sender][asset] = WithdrawRequest({
            amount: amount,
            requestedAt: block.timestamp
        });
        emit WithdrawRequested(msg.sender, asset, amount, block.timestamp);
    }

    function withdraw(address asset, uint256 amount) external {
        WithdrawRequest memory request = withdrawRequests[msg.sender][asset];
        require(request.amount > 0, "no_request");
        require(request.amount == amount, "amount_mismatch");
        require(block.timestamp >= request.requestedAt + withdrawDelaySeconds, "delay_not_elapsed");

        delete withdrawRequests[msg.sender][asset];
        balances[msg.sender][asset] -= amount;
        require(IERC20(asset).transfer(msg.sender, amount), "transfer_failed");
        emit Withdrawn(msg.sender, asset, amount);
    }

    function balanceOf(address owner, address asset) external view returns (uint256) {
        return balances[owner][asset];
    }

    function withdrawRequest(address owner, address asset)
        external
        view
        returns (uint256 amount, uint256 requestedAt)
    {
        WithdrawRequest memory request = withdrawRequests[owner][asset];
        return (request.amount, request.requestedAt);
    }
}
