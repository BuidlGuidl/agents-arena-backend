// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// Minimal stand-in for NFTFlags: the same hasMinted getter the poller reads and
/// the same FlagMinted event it recovers a txHash from.
/// It does NOT guard against re-minting the same challenge, so tests can drive the
/// poller's exactly-once projection with duplicate on-chain logs.
contract FlagMintedFixture {
    event FlagMinted(address indexed minter, uint256 indexed tokenId, uint256 indexed challengeId);

    uint256 public nextTokenId;

    mapping(address => mapping(uint256 => bool)) public hasMinted;

    function mint(address recipient, uint256 challengeId) external {
        uint256 tokenId = nextTokenId++;
        hasMinted[recipient][challengeId] = true;
        emit FlagMinted(recipient, tokenId, challengeId);
    }
}
