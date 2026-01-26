import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { CONFIG, ABIS } from '../config/config';
import { BlockchainService } from './BlockchainService';
import { IdentityService } from './IdentityService';

export class MediaService {
    private prisma: any;
    private sentinelInterval: NodeJS.Timeout | null = null;
    private governanceInterval: NodeJS.Timeout | null = null;
    public sentinelStatus: any = { lastCheck: 0, lastSuccess: false };
    private lastSyncedBlock: number = 0;
    private isChainSyncing: boolean = false;
    private lastSyncPath: string = '';

    constructor(
        private blockchainService: BlockchainService,
        private identityService: IdentityService
    ) { }

    public init(prisma: any) {
        this.prisma = prisma;
        this.lastSyncPath = path.join(CONFIG.DATA_DIR, 'sync_state.json');

        this.startSentinelCron();
        this.startGovernanceJob();
        this.syncMediaFromChain();
    }

    /**
     * Periodically check and update Sentinel status (Migrated from node.ts)
     */
    public startSentinelCron() {
        if (this.sentinelInterval) clearInterval(this.sentinelInterval);

        this.sentinelInterval = setInterval(async () => {
            try {
                if (!this.blockchainService.nodeRegistry || !this.identityService.nodeName) return;

                // Update IP in Registry if changed
                if (this.identityService.publicIp) {
                    // @ts-ignore
                    const info = await this.blockchainService.nodeRegistry.getNode(this.identityService.nodeName.replace('.wara', ''));
                    const currentIpOnChain = info.currentIP || info[4];

                    if (currentIpOnChain !== this.identityService.publicIp && this.identityService.nodeSigner) {
                        console.log(`[Sentinel] IP Mismatch detected. Updating on-chain: ${this.identityService.publicIp}`);
                        const contractWithSigner = this.blockchainService.nodeRegistry.connect(this.identityService.nodeSigner);
                        // @ts-ignore
                        const tx = await contractWithSigner.updateIP(this.identityService.publicIp);
                        await tx.wait();
                        console.log(`[Sentinel] IP Updated: ${tx.hash}`);
                    }
                }
            } catch (e) {
                console.warn("[Sentinel] Cron check failed", e);
            }
        }, 10 * 60 * 1000); // 10 minutes
    }

    /**
     * Handle DAO proposal execution (Migrated from node.ts)
     */
    public startGovernanceJob() {
        if (this.governanceInterval) clearInterval(this.governanceInterval);

        this.governanceInterval = setInterval(async () => {
            try {
                if (!this.prisma) return;

                const now = new Date();
                const threeDaysAgo = new Date(now.getTime() - (3 * 24 * 60 * 60 * 1000));

                const pendingProposals = await this.prisma.media.findMany({
                    where: {
                        status: 'pending_dao',
                        createdAt: { lt: threeDaysAgo }
                    },
                    include: { votes: true }
                });

                if (pendingProposals.length === 0) return;

                const OWNER_PK = process.env.OWNER_PRIVATE_KEY;
                if (!OWNER_PK) return;

                const executorWallet = new ethers.Wallet(OWNER_PK, this.blockchainService.provider);
                const registryWrite = new ethers.Contract(CONFIG.CONTRACTS.MEDIA_REGISTRY, ABIS.MEDIA_REGISTRY, executorWallet);

                for (const proposal of pendingProposals) {
                    const margin = proposal.upvotes - proposal.downvotes;

                    if (margin > 0) {
                        try {
                            // Check if already on chain
                            const [exists] = await registryWrite.exists(proposal.source, proposal.sourceId);
                            if (!exists) {
                                const voters = proposal.votes.map((v: any) => v.voterWallet);
                                const votes = proposal.votes.map((v: any) => v.value);
                                const signatures = proposal.votes.map((v: any) => v.signature);

                                const tx = await registryWrite.registerDAO(
                                    proposal.source,
                                    proposal.sourceId,
                                    proposal.title,
                                    proposal.waraId,
                                    voters,
                                    votes,
                                    signatures
                                );
                                await tx.wait();
                            }

                            await this.prisma.media.update({
                                where: { waraId: proposal.waraId },
                                data: { status: 'approved' }
                            });
                        } catch (e) {
                            console.warn('[Media] Failed to process proposal:', proposal.waraId, e);
                        }
                    } else {
                        await this.prisma.media.update({
                            where: { waraId: proposal.waraId },
                            data: { status: 'rejected' }
                        });
                        const manifestPath = path.join(CONFIG.DATA_DIR, 'media', `${proposal.waraId}.json`);
                        if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
                    }
                }
            } catch (e) {
                console.error('[Media] Blockchain sync error:', e);
            }
        }, 60 * 60 * 1000); // 1 hour
    }

    public async syncMediaFromChain() {
        if (!this.blockchainService.mediaRegistry || this.isChainSyncing) return;
        this.isChainSyncing = true;

        // Load state
        try {
            if (fs.existsSync(this.lastSyncPath)) {
                const state = JSON.parse(fs.readFileSync(this.lastSyncPath, 'utf8'));
                this.lastSyncedBlock = state.lastSyncedBlock || 0;
            }
        } catch (e) {
            console.error('[Media] Governance job error:', e);
        }

        const poll = async () => {
            try {
                const currentBlock = await this.blockchainService.provider.getBlockNumber();
                const fromBlock = this.lastSyncedBlock > 0 ? this.lastSyncedBlock + 1 : CONFIG.START_BLOCK || 0;

                if (fromBlock > currentBlock) return;
                const toBlock = Math.min(currentBlock, fromBlock + 5000);

                console.log(`[ChainSync] Polling for Media Events: ${fromBlock} -> ${toBlock}`);
                const filter = this.blockchainService.mediaRegistry!.filters.MediaRegistered();
                const events = await this.blockchainService.mediaRegistry!.queryFilter(filter, fromBlock, toBlock);

                if (events.length > 0) {
                    console.log(`[ChainSync] Found ${events.length} registrations.`);
                    const { getMediaMetadata } = await import('../utils/tmdb');

                    for (const event of events) {
                        try {
                            const anyEvent = event as any;
                            if (!anyEvent.args) continue;
                            const [source, externalId] = anyEvent.args;
                            console.log(`[ChainSync] New content detected: ${externalId} (${source})`);
                            // Background enrichment
                            getMediaMetadata(this.prisma, externalId, 'movie').catch(() => { });
                        } catch (e) {
                            console.warn('[Media] Failed to download sovereign metadata:', e);
                        }
                    }
                }

                this.lastSyncedBlock = toBlock;
                fs.writeFileSync(this.lastSyncPath, JSON.stringify({ lastSyncedBlock: this.lastSyncedBlock }));
            } catch (e: any) {
                if (!e.message.includes('resource not found')) {
                    console.warn('[ChainSync] Iteration failed:', e.message);
                }
            }
        };

        // Every 6 hours as per legacy
        setInterval(poll, 6 * 60 * 60 * 1000);
        poll();
        this.isChainSyncing = false;
    }

    public stop() {
        if (this.sentinelInterval) clearInterval(this.sentinelInterval);
        if (this.governanceInterval) clearInterval(this.governanceInterval);
    }
}
