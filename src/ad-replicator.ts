import { ethers } from 'ethers';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AD_MANAGER_ADDRESS } from './contracts';

const RPC_URL = process.env.RPC_URL;

const AD_MANAGER_ABI = [
    'event CampaignCreated(uint256 indexed id, address indexed advertiser, uint256 budgetWARA, uint256 viewsGuaranteed, uint8 duration, uint8 category)',
    'function getCampaign(uint256 campaignId) view returns (address advertiser, uint256 budgetWARA, uint8 duration, string videoHash, uint256 viewsRemaining, uint8 category, bool active)',
    'function nextCampaignId() view returns (uint256)'
];

const ADS_DIR = path.join(__dirname, '../wara_store/ads');

// CONFIGURACIÓN (Podría ir en .env)
const METADATA_REPLICATION_RATE = 0.35; // 35% de los nodos guardan metadata (Sharding)
const DATA_REPLICATION_RATE_DEFAULT = 0.10; // 10% guardan video si no hay afinidad
const DISK_THRESHOLD_PERCENT = 0.70; // 70% lleno -> Garbage Collect Agresivo
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 Horas
const START_CAMPAIGN_ID = 52; // IGNORE OLD CAMPAIGNS (DEV RESET)

import { WaraNode } from './node';

export class AdReplicator {
    private provider: ethers.JsonRpcProvider;
    private contract: ethers.Contract;
    private localPort: number;
    private node: WaraNode;
    private gcInterval: NodeJS.Timeout | null = null;
    private lastSyncedBlock: number = 0;
    private isSyncing: boolean = false;
    private pollInterval: NodeJS.Timeout | null = null;

    constructor(node: WaraNode, localPort: number = 21746) {
        this.provider = new ethers.JsonRpcProvider(RPC_URL);
        this.contract = new ethers.Contract(AD_MANAGER_ADDRESS, AD_MANAGER_ABI, this.provider);
        this.localPort = localPort;
        this.node = node;

        // Ensure ads directory exists
        if (!fs.existsSync(ADS_DIR)) {
            fs.mkdirSync(ADS_DIR, { recursive: true });
        }
    }

    async getKnownNodes(): Promise<string[]> {
        try {
            // Query local node's /peers endpoint to get gossip network
            const response = await axios.get(`http://127.0.0.1:${this.localPort}/peers`, { timeout: 5000 });
            const peers = response.data as Array<{ name: string, endpoint: string }>;

            // Extract endpoints + add localhost
            const nodes = peers.map(p => p.endpoint);
            nodes.unshift(`http://127.0.0.1:${this.localPort}`); // Always try local first

            return nodes;
        } catch (error) {
            console.warn('[AdReplicator] Could not fetch peers, using localhost only');
            return [`http://127.0.0.1:${this.localPort}`];
        }
    }

    async start() {
        console.log('[AdReplicator] Starting in 5 seconds (waiting for node)...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        const syncStatePath = path.join(ADS_DIR, 'sync_state.json');
        if (fs.existsSync(syncStatePath)) {
            try {
                const state = JSON.parse(fs.readFileSync(syncStatePath, 'utf8'));
                this.lastSyncedBlock = state.lastSyncedBlock || 0;
            } catch (e) { }
        }

        const poll = async () => {
            if (this.isSyncing) return;
            this.isSyncing = true;

            try {
                const currentBlock = await this.provider.getBlockNumber();
                const fromBlock = this.lastSyncedBlock > 0 ? this.lastSyncedBlock + 1 : 0;

                if (fromBlock <= currentBlock) {
                    const toBlock = Math.min(currentBlock, fromBlock + 5000);
                    const filter = this.contract.filters.CampaignCreated();
                    const events = await this.contract.queryFilter(filter, fromBlock, toBlock);

                    for (const event of events) {
                        try {
                            const { id } = (event as any).args;
                            console.log(`[AdReplicator] New campaign detected via poll: #${id}`);
                            await this.replicateAd(Number(id));
                        } catch (e) { }
                    }

                    this.lastSyncedBlock = toBlock;
                    fs.writeFileSync(syncStatePath, JSON.stringify({ lastSyncedBlock: this.lastSyncedBlock }));
                }
            } catch (e: any) {
                if (!e.message.includes('resource not found')) {
                    console.warn('[AdReplicator] Polling failed:', e.message);
                }
            } finally {
                this.isSyncing = false;
            }
        };

        console.log('[AdReplicator] Polling for CampaignCreated events every 2 hours...');
        this.pollInterval = setInterval(poll, 2 * 60 * 60 * 1000); // Poll every 2 hours
        poll();

        // Replicate existing campaigns on startup (REVERSE ORDER - Newest first)
        this.replicateExistingAds();

        // Start Garbage Collection Loop
        this.gcInterval = setInterval(() => this.runGarbageCollection(), GC_INTERVAL_MS);
        // Run once on start (delayed)
        setTimeout(() => this.runGarbageCollection(), 60000);
    }

    async replicateExistingAds() {
        try {
            const nextId = await this.contract.nextCampaignId();
            const total = Number(nextId);
            console.log(`[AdReplicator] Checking existing campaigns from #${total - 1} down to #${START_CAMPAIGN_ID}...`);

            // Limit startup check to last 50 (to save RPC)
            const start = Math.max(START_CAMPAIGN_ID, total - 50);

            for (let i = total - 1; i >= start; i--) {
                await this.replicateAd(i);
                // Be gentle with RPC
                await new Promise(r => setTimeout(r, 100));
            }
        } catch (error) {
            console.error('[AdReplicator] Error replicating existing ads:', error);
        }
    }

    // DECISION LOGIC: Should I even store the JSON metadata?
    private shouldReplicateMetadata(campaignId: number): boolean {
        // Hash(NodeID + CampaignID)
        const hash = crypto.createHash('sha256').update(this.node.nodeId + campaignId.toString()).digest('hex');
        const val = parseInt(hash.substring(0, 4), 16); // 0-65535
        const threshold = 65535 * METADATA_REPLICATION_RATE;

        return val < threshold;
    }

    // DECISION LOGIC: Should I store the VIDEO file?
    private shouldReplicateData(campaign: any, metadata: any): boolean {
        // 1. Mandatory Checks
        if (!campaign.active) return false;
        if (Number(campaign.viewsRemaining) <= 0) return false;
        if (Number(campaign.budgetWARA) <= 0) return false;

        // 2. Disk Space Check
        try {
            const stats = fs.statfsSync(ADS_DIR);
            const usedPercent = 1 - (stats.bavail / stats.blocks);
            if (usedPercent > DISK_THRESHOLD_PERCENT) {
                console.warn(`[AdReplicator] Disk full (${(usedPercent * 100).toFixed(1)}%). Skipping video download.`);
                return false;
            }
        } catch (e) { /* Ignore if statfs not supported */ }

        // 3. Affinity Checks (Priority)
        // Region Match?
        const myRegion = this.node.region || 'GLOBAL';
        const adRegion = metadata.region || 'GLOBAL'; // Asumimos que metadata tiene region

        if (adRegion !== 'GLOBAL' && myRegion !== 'GLOBAL') {
            if (adRegion === myRegion) return true; // High Priority
            // If region mismatch, drastically reduce probability (or 0)
            return false;
        }

        // 4. Random Redundancy (for Global ads)
        const hash = crypto.createHash('sha256').update(this.node.nodeId + metadata.id).digest('hex');
        const val = parseInt(hash.substring(0, 4), 16);
        const threshold = 65535 * DATA_REPLICATION_RATE_DEFAULT;

        return val < threshold;
    }

    async replicateAd(campaignId: number) {
        try {
            // STEP 0: Metadata Sharding Check
            if (!this.shouldReplicateMetadata(campaignId)) {
                // console.log(`[AdReplicator] Skipped Metadata for #${campaignId} (Sharding)`);
                return;
            }

            const campaign = await this.contract.getCampaign(campaignId);
            const videoHash = campaign.videoHash;

            // Parse hash (ID#KEY or just ID)
            let adId: string;
            if (videoHash.includes('#')) {
                [adId] = videoHash.split('#');
            } else {
                adId = videoHash;
            }

            const localJsonPath = path.join(ADS_DIR, `${adId}.json`);
            const localWaraPath = path.join(ADS_DIR, `${adId}.wara`);

            // Check if already exists fully
            if (fs.existsSync(localWaraPath) && fs.existsSync(localJsonPath)) {
                // Check if we should KEEP it (Garbage Collection lite)
                if (!campaign.active) {
                    console.log(`[AdReplicator] Deleting inactive ad #${campaignId}`);
                    fs.unlinkSync(localWaraPath);
                    // Keep JSON? Maybe remove too.
                    fs.unlinkSync(localJsonPath);
                }
                return;
            }

            // DOWNLOAD METADATA FIRST
            const knownNodes = await this.getKnownNodes();
            let metadata = null;
            let sourceNode = null;

            for (const node of knownNodes) {
                try {
                    const mapRes = await axios.get(`${node}/wara/${adId}/map`, { timeout: 5000 });
                    metadata = mapRes.data;
                    sourceNode = node;
                    break;
                } catch (e) { }
            }

            if (!metadata) {
                // console.warn(`[AdReplicator] Could not find metadata for ${adId}`);
                return;
            }

            // Save Metadata
            fs.writeFileSync(localJsonPath, JSON.stringify(metadata, null, 2));

            // DECIDE TO DOWNLOAD VIDEO
            if (this.shouldReplicateData(campaign, metadata)) {
                console.log(`[AdReplicator] Downloading VIDEO for ${adId} (Eligible)...`);

                try {
                    const streamUrl = `${sourceNode}/wara/${adId}/stream`;
                    const response = await axios.get(streamUrl, {
                        responseType: 'arraybuffer',
                        timeout: 60000
                    });

                    fs.writeFileSync(localWaraPath, Buffer.from(response.data));

                    // Register link if we have the file
                    this.node.registerLink(metadata.id, localWaraPath, metadata);
                    console.log(`[AdReplicator] ✅ Secured Ad #${campaignId} (${response.data.byteLength} bytes)`);
                } catch (e: any) {
                    console.error(`[AdReplicator] Failed download video: ${e.message}`);
                }
            } else {
                // console.log(`[AdReplicator] Metadata saved, but Video skipped (Not eligible)`);
            }

        } catch (error) {
            console.error(`[AdReplicator] Error replicating campaign ${campaignId}:`, error);
        }
    }

    async runGarbageCollection() {
        console.log("[AdReplicator] 🧹 Running Garbage Collection...");
        try {
            const files = fs.readdirSync(ADS_DIR);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            let deletedCount = 0;

            for (const file of jsonFiles) {
                const filePath = path.join(ADS_DIR, file);
                try {
                    // We don't have campaignId in filename usually, but check inside JSON content? 
                    // Or cross reference contract?
                    // NOTE: This is tricky if filename is just hash. 
                    // Strategy: We rely on replicateAd checks. But here we might want to scan ALL.
                    // For now, let's skip deep GC scan to avoid RPC spam, handled by live checks.
                    // Or implement: If disk full, delete oldest.

                    const stats = fs.statSync(filePath);
                    const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

                    // If file is very old > 30 days, delete?
                    if (ageHours > 720) { // 30 days
                        const waraFile = filePath.replace('.json', '.wara');
                        if (fs.existsSync(waraFile)) fs.unlinkSync(waraFile);
                        fs.unlinkSync(filePath);
                        deletedCount++;
                    }

                } catch (e) { }
            }
            if (deletedCount > 0) console.log(`[AdReplicator] GC Cleaned ${deletedCount} old ads.`);

        } catch (e) { console.error("GC Failed", e); }
    }

    stop() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.gcInterval) clearInterval(this.gcInterval);
        console.log('[AdReplicator] Stopped');
    }
}
