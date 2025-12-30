// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/DebitWallet.sol";
import "../src/OdpSettlementWallet.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 withdrawDelay = vm.envOr("WITHDRAW_DELAY_SECONDS", uint256(86400));
        address processor = vm.envOr("PROCESSOR", address(0));

        vm.startBroadcast(deployerKey);

        DebitWallet debitWallet = new DebitWallet(withdrawDelay);
        OdpSettlementWallet settlementWallet = new OdpSettlementWallet(address(debitWallet));
        debitWallet.setSettlementContract(address(settlementWallet));

        if (processor != address(0)) {
            settlementWallet.setProcessor(processor, true);
            settlementWallet.setProcessorsHash(keccak256(abi.encodePacked(processor)));
        }

        vm.stopBroadcast();

        console2.log("DebitWallet:", address(debitWallet));
        console2.log("SettlementWallet:", address(settlementWallet));
    }
}
