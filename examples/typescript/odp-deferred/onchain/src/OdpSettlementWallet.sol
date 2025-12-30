// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { DebitWallet } from "./DebitWallet.sol";

library ECDSA {
    uint256 private constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 private constant SECP256K1_HALF_N = SECP256K1_N / 2;

    function recover(bytes32 hash, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "bad_signature_length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (v < 27) {
            v += 27;
        }
        require(v == 27 || v == 28, "bad_signature_v");
        require(uint256(s) <= SECP256K1_HALF_N, "bad_signature_s");
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0), "bad_signature");
        return signer;
    }
}

/// @notice Reference settlement wallet for ODP deferred sessions.
/// @dev Trusts allowlisted processors to submit correct batch totals.
contract OdpSettlementWallet {
    using ECDSA for bytes32;

    struct SessionApproval {
        address payer;
        address payee;
        address asset;
        uint256 maxSpend;
        uint256 expiry;
        bytes32 sessionId;
        uint256 startNonce;
        bytes32 authorizedProcessorsHash;
    }

    struct SessionState {
        address payer;
        address payee;
        address asset;
        uint256 maxSpend;
        uint256 expiry;
        uint256 startNonce;
        uint256 nextNonce;
        uint256 spent;
        bytes32 authorizedProcessorsHash;
    }

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant SESSION_APPROVAL_TYPEHASH =
        keccak256(
            "SessionApproval(address payer,address payee,address asset,uint256 maxSpend,uint256 expiry,bytes32 sessionId,uint256 startNonce,bytes32 authorizedProcessorsHash)"
        );

    string public constant NAME = "x402-odp-deferred";
    string public constant VERSION = "1";

    DebitWallet public immutable debitWallet;
    address public owner;
    bytes32 public processorsHash;
    mapping(address => bool) public processors;
    mapping(bytes32 => SessionState) public sessions;

    event ProcessorUpdated(address indexed processor, bool allowed);
    event ProcessorsHashUpdated(bytes32 processorsHash);
    event SessionOpened(bytes32 indexed sessionId, address indexed payer);
    event SessionSettled(bytes32 indexed sessionId, uint256 startNonce, uint256 endNonce, uint256 totalAmount);

    constructor(address debitWallet_) {
        require(debitWallet_ != address(0), "zero_debit_wallet");
        debitWallet = DebitWallet(debitWallet_);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not_owner");
        _;
    }

    modifier onlyProcessor() {
        require(processors[msg.sender], "not_processor");
        _;
    }

    function setProcessor(address processor, bool allowed) external onlyOwner {
        processors[processor] = allowed;
        emit ProcessorUpdated(processor, allowed);
    }

    function setProcessorsHash(bytes32 processorsHash_) external onlyOwner {
        processorsHash = processorsHash_;
        emit ProcessorsHashUpdated(processorsHash_);
    }

    function settleSession(
        SessionApproval calldata approval,
        bytes calldata sessionSignature,
        uint256 startNonce,
        uint256 endNonce,
        uint256 totalAmount
    ) external onlyProcessor {
        require(totalAmount > 0, "amount_zero");
        require(startNonce <= endNonce, "invalid_nonce_range");
        require(block.timestamp <= approval.expiry, "session_expired");
        require(approval.payer != address(0), "invalid_payer");

        if (processorsHash != bytes32(0)) {
            require(approval.authorizedProcessorsHash == processorsHash, "processor_hash_mismatch");
        }

        SessionState storage state = sessions[approval.sessionId];
        if (state.payer == address(0)) {
            _verifySessionApproval(approval, sessionSignature);
            sessions[approval.sessionId] = SessionState({
                payer: approval.payer,
                payee: approval.payee,
                asset: approval.asset,
                maxSpend: approval.maxSpend,
                expiry: approval.expiry,
                startNonce: approval.startNonce,
                nextNonce: approval.startNonce,
                spent: 0,
                authorizedProcessorsHash: approval.authorizedProcessorsHash
            });
            state = sessions[approval.sessionId];
            emit SessionOpened(approval.sessionId, approval.payer);
        } else {
            require(state.payer == approval.payer, "payer_mismatch");
            require(state.payee == approval.payee, "payee_mismatch");
            require(state.asset == approval.asset, "asset_mismatch");
            require(state.maxSpend == approval.maxSpend, "max_spend_mismatch");
            require(state.expiry == approval.expiry, "expiry_mismatch");
            require(state.startNonce == approval.startNonce, "start_nonce_mismatch");
            require(state.authorizedProcessorsHash == approval.authorizedProcessorsHash, "processor_hash_mismatch");
        }

        require(startNonce == state.nextNonce, "nonce_mismatch");
        state.nextNonce = endNonce + 1;
        state.spent += totalAmount;
        require(state.spent <= state.maxSpend, "max_spend_exceeded");

        debitWallet.settleFrom(approval.payer, approval.asset, approval.payee, totalAmount);
        emit SessionSettled(approval.sessionId, startNonce, endNonce, totalAmount);
    }

    function _verifySessionApproval(SessionApproval calldata approval, bytes calldata signature) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                SESSION_APPROVAL_TYPEHASH,
                approval.payer,
                approval.payee,
                approval.asset,
                approval.maxSpend,
                approval.expiry,
                approval.sessionId,
                approval.startNonce,
                approval.authorizedProcessorsHash
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        address signer = digest.recover(signature);
        require(signer == approval.payer, "invalid_session_signature");
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }
}
