import { ethers } from 'ethers';
import { CONFIG } from '../config/config';
import { BlockchainService } from './BlockchainService';
import { IdentityService } from './IdentityService';

export class SubscriptionService {
    constructor(
        private blockchainService: BlockchainService,
        private identityService: IdentityService
    ) {}

    /**
     * @notice Checks if a wallet has an active subscription on-chain
     */
    public async isSubscribed(walletAddress: string): Promise<boolean> {
        if (!this.blockchainService.subscriptions) return false;
        try {
            return await this.blockchainService.subscriptions.isSubscribed(walletAddress);
        } catch (e) {
            console.error(`[SubscriptionService] Check failed for ${walletAddress}:`, e);
            return false;
        }
    }

    /**
     * @notice Generates a valid Premium View signature (matches Subscriptions.sol:181)
     * @dev This is usually called by the FRONTEND (Viewer), but the Node needs it for verification.
     */
    public async createPremiumViewHash(
        hoster: string,
        viewer: string,
        contentHash: string,
        nonce: number
    ): Promise<string> {
        const chainId = Number((await this.blockchainService.provider.getNetwork()).chainId);
        const hexContentHash = contentHash.startsWith('0x') ? contentHash : `0x${contentHash}`;

        // keccak256(abi.encodePacked(hoster, viewer, contentHash, nonce, block.chainid))
        return ethers.solidityPackedKeccak256(
            ["address", "address", "bytes32", "uint256", "uint256"],
            [hoster, viewer, hexContentHash, nonce, chainId]
        );
    }

    /**
     * @notice Verifies a premium view signature before accepting it
     */
    public async verifyPremiumSignature(
        hoster: string,
        viewer: string,
        contentHash: string,
        nonce: number,
        signature: string
    ): Promise<boolean> {
        try {
            const hash = await this.createPremiumViewHash(hoster, viewer, contentHash, nonce);
            const recovered = ethers.verifyMessage(ethers.getBytes(hash), signature);
            return recovered.toLowerCase() === viewer.toLowerCase();
        } catch (e) {
            return false;
        }
    }
}
