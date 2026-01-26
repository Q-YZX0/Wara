import { ethers } from 'ethers';
import * as crypto from 'crypto';
import { CatalogService } from './CatalogService';
import { BlockchainService } from './BlockchainService';
import { IdentityService } from './IdentityService';

export interface StreamSession {
    token: string;
    linkId: string;
    clientIp: string;
    expiresAt: number;
    isPremium: boolean;
}

export class StreamService {
    public activeSessions: Map<string, StreamSession> = new Map();
    public sessionDuration = 4 * 60 * 60 * 1000; // 4 Hours default

    constructor(
        private catalogService: CatalogService,
        private blockchainService: BlockchainService,
        private identityService: IdentityService
    ) { }

    /**
     * Main Authorization Logic
     * Determines if a user can watch content.
     */
    public async authorizeRequest(linkId: string, wallet: string, clientIp: string): Promise<{
        status: 'play' | 'show_ad' | 'sign_premium' | 'denied';
        reason?: string;
        token?: string;
        ad?: any;
        message?: string;
    }> {
        // 1. Check Content Existence
        const link = this.catalogService.getLink(linkId);
        if (!link) {
            return { status: 'denied', reason: 'Content not found on this node' };
        }

        // 2. Capacity Check
        if (link.activeStreams >= link.maxStreams) {
            return { status: 'denied', reason: 'Node at capacity' };
        }

        // 3. Premium / Subscription Check
        // If content is marked as "Premium" (via metadata or on-chain logic), check subscription.
        const isPremiumContent = false; // TODO: Implement logic based on Metadata (e.g. if price > 0)

        let hasSubscription = false;
        if (wallet && this.blockchainService.subscriptions) {
            try {
                // @ts-ignore
                hasSubscription = await this.blockchainService.subscriptions.isSubscribed(wallet);
            } catch (e) { }
        }

        // 4. Decision Matrix

        // CASE A: Premium User -> Always Play (Requires Proof of View signature for payment)
        if (hasSubscription) {
            return {
                status: 'sign_premium',
                message: `Premium View: ${linkId}`
            };
        }

        // CASE B: Free User
        // If content is Premium Only -> Deny
        if (isPremiumContent) {
            return { status: 'denied', reason: 'Subscription Required' };
        }

        // If content is Free -> Show Ad
        // We need to fetch an ad campaign from AdManager
        const campaign = await this.fetchAdCampaign();

        if (campaign) {
            return { status: 'show_ad', ad: campaign };
        } else {
            // No Ads available? Allow play (or deny if strict)
            // For now, if ad system is empty, we allow play to avoid broken UX
            const token = this.createSession(linkId, clientIp, false);
            return { status: 'play', token, reason: 'No ads available (Free)' };
        }
    }

    public createSession(linkId: string, clientIp: string, isPremium: boolean): string {
        const token = crypto.randomBytes(32).toString('hex');
        this.activeSessions.set(token, {
            token,
            linkId,
            clientIp,
            expiresAt: Date.now() + this.sessionDuration,
            isPremium
        });

        // Track stats
        const link = this.catalogService.getLink(linkId);
        if (link) link.activeStreams++;

        return token;
    }

    public validateSession(token: string): StreamSession | null {
        const session = this.activeSessions.get(token);
        if (!session) return null;

        if (Date.now() > session.expiresAt) {
            this.activeSessions.delete(token);
            // Decrement stats
            const link = this.catalogService.getLink(session.linkId);
            if (link) link.activeStreams = Math.max(0, link.activeStreams - 1);
            return null;
        }

        return session;
    }

    public endSession(token: string) {
        const session = this.activeSessions.get(token);
        if (session) {
            const link = this.catalogService.getLink(session.linkId);
            if (link) link.activeStreams = Math.max(0, link.activeStreams - 1);
            this.activeSessions.delete(token);
        }
    }

    private async fetchAdCampaign() {
        if (!this.blockchainService.adManager) return null;

        try {
            // Find active campaign (Round Robin or specialized logic needed)
            // For now, rudimentary randomness or nextCampaignId scan

            // @ts-ignore
            const maxId = await this.blockchainService.adManager.nextCampaignId();
            if (Number(maxId) === 0) return null;

            // Try 3 random IDs
            for (let i = 0; i < 3; i++) {
                const id = Math.floor(Math.random() * Number(maxId));
                // @ts-ignore
                const c = await this.blockchainService.adManager.getCampaign(id);
                // c: [advertiser, budget, duration, videoHash, viewsRem, cat, active]
                if (c && c[6] === true && c[4] > 0) { // active && viewsRemaining > 0
                    return {
                        id: id,
                        videoHash: c[3],
                        duration: c[2],
                        advertiser: c[0]
                    };
                }
            }
        } catch (e) { }
        return null;
    }
}
