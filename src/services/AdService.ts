import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import axios from 'axios';
import { BlockchainService } from './BlockchainService';
import { IdentityService } from './IdentityService';
import { P2PService } from './P2PService';
import { CatalogService } from './CatalogService';
import { CONFIG } from '../config/config';
import { AdCampaign } from '../types';

// CONSTANTS (Refactored from ad-replicator)
const METADATA_REPLICATION_RATE = 0.35;
const DATA_REPLICATION_RATE_DEFAULT = 0.10;
const DISK_THRESHOLD_PERCENT = 0.70;
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const START_CAMPAIGN_ID = 0;

export class AdService {
    private adsDir: string;
    private pollInterval: NodeJS.Timeout | null = null;
    private gcInterval: NodeJS.Timeout | null = null;
    private isSyncing: boolean = false;
    private lastSyncedBlock: number = 0;

    constructor(
        private blockchainService: BlockchainService,
        private identityService: IdentityService,
        private p2pService: P2PService,
        private catalogService: CatalogService
    ) {
        this.adsDir = path.join(CONFIG.DATA_DIR, 'ads');
        if (!fs.existsSync(this.adsDir)) fs.mkdirSync(this.adsDir, { recursive: true });
    }

    public async init() {
        console.log('[AdService] Initializing Service...');

        // Load Sync State
        const syncStatePath = path.join(this.adsDir, 'sync_state.json');
        try {
            await fs.promises.access(syncStatePath);
            const stateData = await fs.promises.readFile(syncStatePath, 'utf8');
            const state = JSON.parse(stateData);
            this.lastSyncedBlock = state.lastSyncedBlock || 0;
        } catch (e) {
            // No state or error reading, ignore
            // console.error('[AdService] Failed to load sync state:', e);
        }

        // Start Background Jobs
        this.pollInterval = setInterval(() => this.pollBlockchain(), 2 * 60 * 60 * 1000); // 2 Hours
        this.gcInterval = setInterval(() => this.runGarbageCollection(), GC_INTERVAL_MS);

        // Initial Run (Delayed)
        setTimeout(() => this.pollBlockchain(), 5000);
        setTimeout(() => this.runGarbageCollection(), 60000);

        // Initial Replicate Check (Reverse)
        setTimeout(() => this.replicateExistingAds(), 10000);
    }

    public stop() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.gcInterval) clearInterval(this.gcInterval);
    }

    // --- REPLICATION LOGIC ---

    private async pollBlockchain() {
        if (this.isSyncing || !this.blockchainService.adManager) return;
        this.isSyncing = true;

        try {
            const contract = this.blockchainService.adManager;
            const currentBlock = await this.blockchainService.provider.getBlockNumber();
            const fromBlock = this.lastSyncedBlock > 0 ? this.lastSyncedBlock + 1 : 0;

            if (fromBlock <= currentBlock) {
                const toBlock = Math.min(currentBlock, fromBlock + 5000);
                const filter = contract.filters.CampaignCreated();

                const events = await contract.queryFilter(filter, fromBlock, toBlock);

                for (const event of events) {
                    if ('args' in event) {
                        try {
                            const { id } = (event as any).args;
                            console.log(`[AdService] New campaign detected: #${id}`);
                            await this.replicateAd(Number(id));
                        } catch (e) {
                            console.error('[AdService] Failed to replicate ad metadata:', e);
                        }
                    }
                }

                this.lastSyncedBlock = toBlock;
                await fs.promises.writeFile(path.join(this.adsDir, 'sync_state.json'), JSON.stringify({ lastSyncedBlock: this.lastSyncedBlock }));
            }
        } catch (e: any) {
            console.warn('[AdService] Polling failed:', e.message);
        } finally {
            this.isSyncing = false;
        }
    }

    private async replicateExistingAds() {
        if (!this.blockchainService.adManager) return;
        try {
            const nextId = await this.blockchainService.adManager.nextCampaignId();
            const total = Number(nextId);
            if (total === 0) return;

            const start = Math.max(START_CAMPAIGN_ID, total - 50);

            console.log(`[AdService] Backfilling campaigns #${start} to #${total - 1}...`);
            for (let i = total - 1; i >= start; i--) {
                await this.replicateAd(i);
                await new Promise(r => setTimeout(r, 100)); // Rate limit
            }
        } catch (e) {
            console.error('[AdService] Blockchain polling error:', e);
        }
    }

    public async replicateAd(campaignId: number) {
        if (!this.blockchainService.adManager) return;

        try {
            // 0. Metadata Sharding Check
            if (!this.shouldReplicateMetadata(campaignId)) return;

            const campaign = await this.blockchainService.adManager.getCampaign(campaignId) as unknown as AdCampaign;
            const videoHash: string = campaign.videoHash;

            const adId = videoHash.includes('#') ? videoHash.split('#')[0] : videoHash;

            const localJsonPath = path.join(this.adsDir, `${adId}.json`);
            const localWaraPath = path.join(this.adsDir, `${adId}.wara`);

            // Check existence
            let waraExists = false;
            let jsonExists = false;
            try { await fs.promises.access(localWaraPath); waraExists = true; } catch (e) { }
            try { await fs.promises.access(localJsonPath); jsonExists = true; } catch (e) { }

            if (waraExists && jsonExists) {
                // GC Check: If inactive, delete?
                if (!campaign.active) {
                    try { await fs.promises.unlink(localWaraPath); } catch (e) { }
                    // fs.unlinkSync(localJsonPath); // Keep metadata?
                }
                return;
            }

            // 1. Download Metadata (P2P Discovery)
            const metadata = await this.fetchMetadataFromNetwork(adId);
            if (!metadata) return;

            // Save Metadata
            await fs.promises.writeFile(localJsonPath, JSON.stringify(metadata, null, 2));

            // 2. Download Media Check

            if (await this.shouldReplicateData(campaign, metadata)) {
                console.log(`[AdService] Downloading VIDEO for ${adId}...`);
                await this.downloadVideoFromNetwork(adId, localWaraPath, metadata);
            }

        } catch (e) {
            console.error(`[AdService] Replication error #${campaignId}`, e);
        }
    }

    private async fetchMetadataFromNetwork(adId: string): Promise<any> {
        // Try local cache first? No, we are here because we don't have it.
        const peers = Array.from(this.p2pService.knownPeers.values());
        // Shuffle
        peers.sort(() => 0.5 - Math.random());

        // Add localhost as fallback? No, P2P logic.

        for (const peer of peers) {
            try {
                const res = await axios.get(`${peer.endpoint}/api/stream/${adId}/map`, { timeout: 3000 });
                if (res.status === 200 && res.data) return res.data;
            } catch (e) {
                // console.error('[AdService] Failed to save sync state:', e); // Typo in original log
            }
        }
        return null;
    }

    private async downloadVideoFromNetwork(adId: string, destPath: string, metadata: any) {
        const peers = Array.from(this.p2pService.knownPeers.values());
        // Simple strategy: Try until one works
        for (const peer of peers) {
            try {
                const streamUrl = `${peer.endpoint}/api/stream/${adId}`; // Using the API endpoint for stream
                const response = await axios.get(streamUrl, {
                    responseType: 'arraybuffer',
                    timeout: 60000
                });

                await fs.promises.writeFile(destPath, Buffer.from(response.data));

                // Register with Catalog Service
                this.catalogService.registerLink(metadata.id, destPath, metadata);
                console.log(`[AdService] ✅ Secured Ad Media: ${metadata.title}`);
                return;
            } catch (e) {
                console.warn('[AdService] Failed to download ad data:', e instanceof Error ? e.message : e);
            }
        }
    }

    private shouldReplicateMetadata(campaignId: number): boolean {
        const nodeAddr = this.identityService.nodeSigner?.address || 'default';
        const hash = crypto.createHash('sha256').update(nodeAddr + campaignId.toString()).digest('hex');
        const val = parseInt(hash.substring(0, 4), 16);
        const threshold = 65535 * METADATA_REPLICATION_RATE;
        return val < threshold;
    }

    private async shouldReplicateData(campaign: any, metadata: any): Promise<boolean> {
        if (!campaign.active) return false;
        if (Number(campaign.viewsRemaining) <= 0) return false;

        // Disk Check
        try {
            // @ts-ignore
            // Uses FS sync originally. statfs might be missing on some nodes.
            // We'll try to use fs.promises.statfs if available, or skip check.
            if (fs.promises.statfs) {
                const stats = await fs.promises.statfs(this.adsDir);
                const usedPercent = 1 - (stats.bavail / stats.blocks);
                if (usedPercent > DISK_THRESHOLD_PERCENT) return false;
            }
        } catch (e) {
            console.error('[AdService] Failed to replicate ad data (disk check):', e);
        }

        // Affinity
        const myRegion = this.identityService.region || 'GLOBAL';
        const adRegion = metadata.region || 'GLOBAL';
        if (adRegion !== 'GLOBAL' && myRegion !== 'GLOBAL') {
            if (adRegion === myRegion) return true;
            return false;
        }

        // Random
        const nodeAddr = this.identityService.nodeSigner?.address || 'default';
        const hash = crypto.createHash('sha256').update(nodeAddr + metadata.id).digest('hex');
        const val = parseInt(hash.substring(0, 4), 16);
        const threshold = 65535 * DATA_REPLICATION_RATE_DEFAULT;
        return val < threshold;
    }

    public async runGarbageCollection() {
        console.log("[AdService] 🧹 Running Garbage Collection...");
        try {
            const files = await fs.promises.readdir(this.adsDir);
            const jsonFiles = files.filter(f => f.endsWith('.json'));
            let deletedCount = 0;

            for (const file of jsonFiles) {
                const filePath = path.join(this.adsDir, file);
                try {
                    const stats = await fs.promises.stat(filePath);
                    const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

                    if (ageHours > 720) { // 30 Days
                        const waraFile = filePath.replace('.json', '.wara');
                        try {
                            await fs.promises.access(waraFile);
                            await fs.promises.unlink(waraFile);
                        } catch (e) { }

                        await fs.promises.unlink(filePath);
                        deletedCount++;
                    }
                } catch (e) {
                    console.warn('[AdService] Failed to delete expired ad:', e);
                }
            }
            if (deletedCount > 0) console.log(`[AdService] Processed ${deletedCount} items.`);
        } catch (e) {
            console.error('[AdService] Garbage collection error:', e);
        }
    }


    // --- SIGNING & CLAIMING (From Phase 5) ---

    public async signAdView(
        campaignId: number,
        viewerAddress: string,
        contentHash: string,
        linkId: string
    ): Promise<string> {
        if (!this.identityService.nodeSigner) {
            throw new Error("Node does not have a signer configured");
        }
        const message = `AdView:${campaignId}:${viewerAddress}:${contentHash}:${linkId}`;
        return await this.identityService.nodeSigner.signMessage(message);
    }

    public async submitClaim(
        campaignId: number,
        viewer: string,
        contentHash: string,
        linkId: string,
        signature: string
    ) {
        if (!this.blockchainService.adManager) throw new Error("AdManager contract not connected");
        try {
            // @ts-ignore
            const tx = await this.blockchainService.adManager.claimAdView(campaignId, viewer, contentHash, linkId, signature);
            console.log(`[AdService] Claim TX sent: ${tx.hash}`);
            return tx;
        } catch (e: any) {
            console.error(`[AdService] Claim failed: ${e.message}`);
            throw e;
        }
    }

    public async reportAd(campaignId: number, reasonCode: number) {
        if (!this.blockchainService.adManager) throw new Error("AdManager disconnected");
        try {
            // @ts-ignore
            const tx = await this.blockchainService.adManager.reportAd(campaignId, reasonCode);
            console.log(`[AdService] Reported Ad #${campaignId}`);
            return tx;
        } catch (e: any) {
            console.error(`[AdService] Report failed: ${e.message}`);
            throw e;
        }
    }
}
