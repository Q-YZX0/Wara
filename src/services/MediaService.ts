import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { CONFIG, ABIS } from '../config/config';
import { BlockchainService } from './BlockchainService';
import { IdentityService } from './IdentityService';
import { MetaService } from './MetaService';

export class MediaService {
    private prisma: any;
    private sentinelInterval: NodeJS.Timeout | null = null;
    private governanceInterval: NodeJS.Timeout | null = null;
    public sentinelStatus: any = { lastCheck: 0, lastSuccess: false };
    private lastSyncedBlock: number = 0;
    private isChainSyncing: boolean = false;
    private lastSyncPath: string = '';
    private node: any;

    constructor(
        private blockchainService: BlockchainService,
        private identityService: IdentityService
    ) { }

    public init(prisma: any, node?: any) {
        this.prisma = prisma;
        this.node = node;
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

                // NOTE: Resolution of proposals should happen on-chain via resolveProposal.
                // The automated job below is for local state maintenance.
                for (const proposal of pendingProposals) {
                    const margin = proposal.upvotes - proposal.downvotes;

                    if (margin > 0) {
                        // If it's old and has positive margin, we consider it 'approved' locally 
                        // to show it in the UI, while waiting for the on-chain resolution transaction.
                        await this.prisma.media.update({
                            where: { waraId: proposal.waraId },
                            data: { status: 'approved' }
                        });
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
                console.error('[Media] Governance local update error:', e);
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
                    for (const event of events) {
                        try {
                            const anyEvent = event as any;
                            if (!anyEvent.args) continue;
                            const [mediaId, source, externalId, title] = anyEvent.args;

                            // PROGRESSIVE ENHANCEMENT STRATEGY (2-Phase Sync)
                            // PHASE 1: Create skeleton from blockchain event (guaranteed data)
                            // This ensures the content exists in DB immediately, even if enrichment fails
                            await this.prisma.media.upsert({
                                where: { waraId: mediaId },
                                update: { title: title }, // At least update title if it changed
                                create: {
                                    waraId: mediaId,
                                    source: source,
                                    sourceId: externalId,
                                    title: title,
                                    type: 'movie', // Default
                                    status: 'approved'
                                }
                            });

                            // PHASE 2: Enrich with P2P/TMDB metadata (best effort, background)
                            // If this fails, we still have the skeleton and can retry on next sync
                            MetaService.getMediaMetadata(this.prisma, externalId, 'movie', 'approved', this.node, source).catch(() => { });
                        } catch (e) {
                            console.warn(`[ChainSync] Media register error:`, e);
                        }
                    }
                }

                // 1.1 "PROPOSALS": Sync Pending DAO content
                const proposalFilter = this.blockchainService.mediaRegistry!.filters.ProposalCreated();
                const proposalEvents = await this.blockchainService.mediaRegistry!.queryFilter(proposalFilter, fromBlock, toBlock);

                for (const event of proposalEvents) {
                    try {
                        const [mediaId, source, externalId, title, deadline] = (event as any).args;

                        // PROGRESSIVE ENHANCEMENT STRATEGY (2-Phase Sync)
                        // PHASE 1: Create skeleton from blockchain event (guaranteed data)
                        // This ensures proposed content exists in DB immediately for DAO voting
                        await this.prisma.media.upsert({
                            where: { waraId: mediaId },
                            update: { title: title },
                            create: {
                                waraId: mediaId,
                                title: title,
                                source: source,
                                sourceId: externalId,
                                type: 'movie',
                                status: 'pending_dao',
                                createdAt: new Date()
                            }
                        });

                        // PHASE 2: Enrich with P2P/TMDB metadata (best effort, background)
                        // If this fails, we still have the skeleton and can retry on next sync
                        MetaService.getMediaMetadata(this.prisma, externalId, 'movie', 'pending_dao', this.node, source).catch(() => { });

                    } catch (e) { }
                }

                // 1.2 "VOTES": Sync community votes
                const votedFilter = this.blockchainService.mediaRegistry!.filters.Voted();
                const votedEvents = await this.blockchainService.mediaRegistry!.queryFilter(votedFilter, fromBlock, toBlock);

                for (const event of votedEvents) {
                    try {
                        const [mediaId, voter, side] = (event as any).args;
                        const value = Number(side); // 1 or -1

                        await this.prisma.media.update({
                            where: { waraId: mediaId },
                            data: {
                                upvotes: value > 0 ? { increment: 1 } : undefined,
                                downvotes: value < 0 ? { increment: 1 } : undefined
                            }
                        }).catch(() => { }); // Media might not be in DB yet
                    } catch (e) { }
                }

                // 1.3 "EXECUTION": Resolve proposals
                const executedFilter = this.blockchainService.mediaRegistry!.filters.ProposalExecuted();
                const executedEvents = await this.blockchainService.mediaRegistry!.queryFilter(executedFilter, fromBlock, toBlock);

                for (const event of executedEvents) {
                    try {
                        const [mediaId, approved] = (event as any).args;
                        await this.prisma.media.update({
                            where: { waraId: mediaId },
                            data: { status: approved ? 'approved' : 'rejected' }
                        }).catch(() => { });
                    } catch (e) { }
                }

                this.lastSyncedBlock = toBlock;

                // 2. Poll for New Links (Global Discovery)
                if (this.blockchainService.linkRegistry) {
                    console.log(`[ChainSync] Polling for Link Events: ${fromBlock} -> ${toBlock}`);
                    const linkFilter = this.blockchainService.linkRegistry!.filters.LinkRegistered();
                    const linkEvents = await this.blockchainService.linkRegistry!.queryFilter(linkFilter, fromBlock, toBlock);

                    for (const event of linkEvents) {
                        try {
                            const anyEvent = event as any;
                            if (!anyEvent.args) continue;
                            const [linkId, contentHash, mediaHash, hoster, salt] = anyEvent.args;

                            // Find media metadata record
                            const media = await this.prisma.media.findUnique({ where: { waraId: mediaHash } });
                            if (!media) {
                                // If we don't have media info yet, we skip this link for now 
                                // (It will be findable once Media syncs and we search again)
                                continue;
                            }

                            // Create or update remote link record
                            await this.prisma.link.upsert({
                                where: { id: linkId },
                                update: {
                                    url: hoster.toLowerCase(), // In P2P links, URL is the hoster wallet address
                                    status: 'active'
                                },
                                create: {
                                    id: linkId,
                                    waraId: mediaHash,
                                    source: media.source,
                                    sourceId: media.sourceId,
                                    mediaType: media.type,
                                    title: media.title,
                                    url: hoster.toLowerCase(),
                                    uploaderWallet: hoster.toLowerCase(),
                                    waraMetadata: JSON.stringify({
                                        hash: contentHash,
                                        salt: salt,
                                        origin: 'blockchain_sync'
                                    })
                                }
                            });
                        } catch (e) {
                            // Link sync error
                        }
                    }
                }

                fs.writeFileSync(this.lastSyncPath, JSON.stringify({ lastSyncedBlock: this.lastSyncedBlock }));
            } catch (e: any) {
                if (!e.message.includes('resource not found')) {
                    console.warn('[ChainSync] Iteration failed:', e.message);
                }
            }
        };

        // Every 6 hours as per original design
        setInterval(poll, 6 * 60 * 60 * 1000);
        poll();
        this.isChainSyncing = false;
    }

    public stop() {
        if (this.sentinelInterval) clearInterval(this.sentinelInterval);
        if (this.governanceInterval) clearInterval(this.governanceInterval);
    }
}
