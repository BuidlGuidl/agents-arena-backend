// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// The aggregate3 subset of Multicall3 that viem's multicall action calls, matching the
/// canonical contract's signatures and its allowFailure semantics.
/// Neither anvil nor the CTF's hardhat chain deploys Multicall3, so a test that wants the
/// aggregated read path has to put this at the canonical address itself.
contract Multicall3Fixture {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData) {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; i++) {
            Result memory result = returnData[i];
            Call3 calldata call = calls[i];
            (result.success, result.returnData) = call.target.call(call.callData);
            if (!result.success && !call.allowFailure) {
                revert("Multicall3: call failed");
            }
        }
    }
}
