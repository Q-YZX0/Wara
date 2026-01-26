import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { CONFIG } from '../config/config';
import { IdentityService } from './IdentityService';
import { BlockchainService } from './BlockchainService';
import { WaraPeer } from '../types';

export class P2PService {
    public knownPeers: Map<string, WaraPeer> = new Map();
    public trackers: string[] = [];
    private isSyncing = false;
    private prisma: any;
    public heartbeatInterval: NodeJS.Timeout | null = null;
    public gossipInterval: NodeJS.Timeout | null = null;

    constructor(
        public identityService: IdentityService,
        private blockchainService: BlockchainService
    ) { }

    public setContext(prisma: any) {
        this.prisma = prisma;
    }

    public async init() {
        this.loadPeers();
        this.loadTrackers();

        // Initial Bootstrap
        await this.syncNetwork();

        // Start Background Jobs
        this.startHeartbeat();
        this.startGossip();

        console.log(`[P2P] Initialized with ${this.knownPeers.size} peers and ${this.trackers.length} trackers.`);
    }

    private loadPeers() {
        try {
            const pPath = path.join(CONFIG.DATA_DIR, 'peers.json');
            if (fs.existsSync(pPath)) {
                const data: WaraPeer[] = JSON.parse(fs.readFileSync(pPath, 'utf8'));
                data.forEach(p => this.knownPeers.set(p.name, p));
            }
        } catch (e) {
            console.error("[P2P] Failed to load peers", e);
        }
    }

    public savePeers() {
        try {
            const pPath = path.join(CONFIG.DATA_DIR, 'peers.json');
            const data = Array.from(this.knownPeers.values());
            fs.writeFileSync(pPath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.warn('[P2P] Failed to load peers:', e);
        }
    }

    private loadTrackers() {
        try {
            const tPath = path.join(CONFIG.DATA_DIR, 'trackers.json');
            if (fs.existsSync(tPath)) {
                this.trackers = JSON.parse(fs.readFileSync(tPath, 'utf8'));
            } else {
                // Default Trackers if file doesn't exist
                this.trackers = [];
                this.saveTrackers();
            }
        } catch (e) {
            console.warn('[P2P] Failed to save peers:', e);
        }
    }

    public saveTrackers() {
        try {
            const tPath = path.join(CONFIG.DATA_DIR, 'trackers.json');
            fs.writeFileSync(tPath, JSON.stringify(this.trackers, null, 2));
        } catch (e) {
            console.warn('[P2P] Failed to load trackers:', e);
        }
    }

    public async syncNetwork() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        const publicIp = this.identityService.publicIp;
        console.log(`[P2P] Starting Network Sync (IP: ${publicIp || 'Unknown'})...`);

        try {
            // 0. Bootstrap
            await this.bootstrapFromSentinel();
            await this.discoverFromTrackers();

            // 1. Catalog Sync with random peers
            const peers = Array.from(this.knownPeers.values()).sort(() => 0.5 - Math.random()).slice(0, 5);
            // @ts-ignore
            const fetch = (await import('node-fetch')).default as any;
            const { getMediaMetadata } = await import('../utils/tmdb');

            for (const peer of peers) {
                if (peer.name === this.identityService.nodeName) continue;

                try {
                    console.log(`[P2P] Syncing catalog with ${peer.name}...`);
                    const res = await fetch(`${peer.endpoint}/api/catalog`, { signal: AbortSignal.timeout(5000) });
                    if (!res.ok) continue;

                    const catalog: any[] = await res.json();
                    for (const item of catalog) {
                        await this.processSyncedItem(item, peer, fetch, getMediaMetadata);
                    }
                } catch (e) { }
            }

            this.savePeers();
        } catch (e) {
            console.error("[P2P] Sync Failed", e);
        } finally {
            this.isSyncing = false;
        }
    }

    private async processSyncedItem(item: any, peer: WaraPeer, fetch: any, getMediaMetadata: any) {
        if (!this.prisma) return;
        const source = item.source || 'tmdb';
        const sourceId = item.sourceId;
        if (!sourceId) return;

        let media = await this.prisma.media.findUnique({
            where: { source_sourceId: { source, sourceId } }
        });

        // Sovereign Metadata Sync
        if (!media && item.waraId) {
            try {
                const mediaRes = await fetch(`${peer.endpoint}/api/media/stream/${item.waraId}`, { signal: AbortSignal.timeout(3000) });
                if (mediaRes.ok) {
                    const remoteMedia = await mediaRes.json();
                    media = await this.prisma.media.upsert({
                        where: { waraId: remoteMedia.waraId },
                        update: { ...remoteMedia },
                        create: { ...remoteMedia }
                    });

                    // Image Sync (Posters)
                    const postersDir = path.join(CONFIG.DATA_DIR, 'posters');
                    const postersDest = path.join(postersDir, `${sourceId}.jpg`);
                    if (!fs.existsSync(postersDest)) {
                        try {
                            if (!fs.existsSync(postersDir)) fs.mkdirSync(postersDir, { recursive: true });
                            const imgRes = await fetch(`${peer.endpoint}/api/catalog/poster/${sourceId}`, { signal: AbortSignal.timeout(5000) });
                            if (imgRes.ok) {
                                const dest = fs.createWriteStream(postersDest);
                                imgRes.body.pipe(dest);
                            }
                        } catch (e) { }
                    }
                }
            } catch (e) {
                console.warn('[P2P] Heartbeat failed:', e instanceof Error ? e.message : e);
            }
        }

        // TMDB Enrichment fallback
        if (!media && source === 'tmdb') {
            media = await getMediaMetadata(this.prisma, sourceId, item.mediaType || 'movie');
        }

        if (media) {
            const storageAuthority = peer.name;
            const existingLink = await this.prisma.link.findFirst({
                where: {
                    url: storageAuthority,
                    sourceId: media.sourceId,
                    uploaderWallet: item.uploaderWallet
                }
            });

            if (!existingLink) {
                await this.prisma.link.create({
                    data: {
                        url: storageAuthority,
                        title: item.title || `[P2P] ${media.title}`,
                        waraId: media.waraId,
                        source: media.source,
                        sourceId: media.sourceId,
                        mediaType: media.type,
                        uploaderWallet: item.uploaderWallet,
                        trustScore: 10,
                        waraMetadata: item.waraMetadata ? JSON.stringify(item.waraMetadata) : null
                    }
                });
            }
        }
    }

    private async bootstrapFromSentinel() {
        if (!this.blockchainService.nodeRegistry) return;
        try {
            // @ts-ignore
            const res = await this.blockchainService.nodeRegistry.getBootstrapNodes(20);
            const names = res[0] || res.names || [];
            const ips = res[1] || res.ips || [];

            for (let i = 0; i < names.length; i++) {
                const name = names[i];
                const endpoint = ips[i];
                if (!name || !endpoint) continue;

                // Skip Self
                if (endpoint.includes(this.identityService.publicIp || '0.0.0.0')) continue;
                if (name === this.identityService.nodeName) continue;

                if (!this.knownPeers.has(name)) {
                    this.knownPeers.set(name, {
                        name,
                        endpoint,
                        lastSeen: Date.now(),
                        isTrusted: true // Sentinel nodes are implicitly trusted registry entries (though IP check pending)
                    });
                    console.log(`[P2P] Sentinel Discovery: ${name}`);
                }
            }
        } catch (e) {
            console.warn("[P2P] Sentinel Bootstrap failed (Contract access issue?)");
        }
    }

    private async discoverFromTrackers() {
        // @ts-ignore
        const fetch = (await import('node-fetch')).default;
        for (const tracker of this.trackers) {
            try {
                const res = await fetch(`${tracker}/api/network/peers`);
                if (res.ok) {
                    const data: any = await res.json();
                    const peers: WaraPeer[] = Array.isArray(data) ? data : data.peers || [];

                    for (const p of peers) {
                        if (p.name === this.identityService.nodeName) continue;
                        if (!this.knownPeers.has(p.name)) {
                            // Verify Identity 
                            const verified = await this.verifyPeerIdentity(p.name, p.endpoint, p.signature);

                            this.knownPeers.set(p.name, {
                                ...p,
                                lastSeen: Date.now(),
                                isTrusted: !!verified,
                                walletAddress: verified?.address
                            });
                        }
                    }
                }
            } catch (e) { }
        }
    }

    public async verifyPeerIdentity(name: string, endpoint: string, signature?: string): Promise<{ address: string } | null> {
        if (!signature || !name || !endpoint) return null;
        try {
            // 1. Resolve from Registry
            let nodeAddress = ethers.ZeroAddress;
            let active = false;

            if (this.blockchainService.nodeRegistry) {
                const cleanName = name.replace('.wara', '');
                // @ts-ignore
                const info = await this.blockchainService.nodeRegistry.getNode(cleanName);
                if (info) {
                    nodeAddress = info.nodeAddress || info[1];
                    active = info.active || info[3];
                }
            }

            const message = `WaraNode:${name}:${endpoint}`;
            const recovered = ethers.verifyMessage(message, signature);

            if (active && nodeAddress !== ethers.ZeroAddress) {
                // Registered Node
                if (recovered.toLowerCase() === nodeAddress.toLowerCase()) {
                    return { address: recovered };
                }
            } else {
                // Anonymous / Unregistered Node
                // We trust the signature matches the name if the name IS the address?
                // Or just validity of signature.
                return { address: recovered };
            }
        } catch (e) {
            console.error('[P2P] Network sync error:', e);
        }
        return null;
    }

    public startHeartbeat() {
        // Stop existing
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

        // HTTP Announce to Trackers
        this.heartbeatInterval = setInterval(async () => {
            if (this.trackers.length === 0) return;
            // @ts-ignore
            const fetch = (await import('node-fetch')).default;

            // NOTE: In full implementation, we'd inject stats from other services here
            const payload = {
                nodeId: this.identityService.nodeSigner?.address || 'unknown',
                endpoint: `http://${this.identityService.publicIp || 'localhost'}:${CONFIG.PORT}`,
                stats: { overloaded: false } // placeholder
            };

            for (const t of this.trackers) {
                try {
                    await fetch(`${t}/announce`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                } catch (e) { }
            }
        }, 30000);
    }

    private startGossip() {
        this.gossipInterval = setInterval(async () => {
            const peers = Array.from(this.knownPeers.values());
            if (peers.length === 0) return;

            // Random Fanout
            const targets = peers.sort(() => 0.5 - Math.random()).slice(0, 3);
            const myPayload = await this.buildGossipPayload(peers);

            // @ts-ignore
            const fetch = (await import('node-fetch')).default;
            for (const target of targets) {
                try {
                    await fetch(`${target.endpoint}/api/network/gossip`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(myPayload)
                    });
                } catch (e) { }
            }
        }, 60000);
    }

    private async buildGossipPayload(allPeers: WaraPeer[]) {
        // Myself
        const myPeer: WaraPeer = {
            name: this.identityService.nodeName || this.identityService.nodeSigner?.address || 'unknown',
            endpoint: `http://${this.identityService.publicIp || 'localhost'}:${CONFIG.PORT}`,
            lastSeen: Date.now()
        };

        if (this.identityService.nodeSigner) {
            const msg = `WaraNode:${myPeer.name}:${myPeer.endpoint}`;
            myPeer.signature = await this.identityService.nodeSigner.signMessage(msg);
        }

        // Selection of peers (Random shuffle)
        const subset = allPeers.sort(() => 0.5 - Math.random()).slice(0, 10);

        return {
            peers: [myPeer, ...subset],
            timestamp: Date.now()
        };
    }

    public getTrackers(): string[] {
        return this.trackers;
    }

    public addTracker(url: string) {
        if (!this.trackers.includes(url)) {
            this.trackers.push(url);
            this.saveTrackers();
        }
    }

    public removeTracker(url: string) {
        this.trackers = this.trackers.filter(t => t !== url);
        this.saveTrackers();
    }

    public async resolveSentinelNode(name: string): Promise<string | null> {
        if (!this.blockchainService.nodeRegistry) return null;
        try {
            const clean = name.replace('.wara', '');
            const info = await this.blockchainService.nodeRegistry.getNode(clean);
            // [operator, nodeAddress, expiresAt, active, currentIP]
            const ip = info[4] || info.currentIP;
            const isActive = info.active && info.expiresAt > Date.now() / 1000;

            if (ip && isActive) {
                console.log(`[P2P] Resolved ${name} -> ${ip}`);
                return ip;
            }
            return null;
        } catch (e) {
            console.warn(`[P2P] Failed to resolve ${name}`);
            return null;
        }
    }

    public stop() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.gossipInterval) clearInterval(this.gossipInterval);
    }
}
