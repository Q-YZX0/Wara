import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
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
    public trackerbeatInterval: NodeJS.Timeout | null = null;
    public gossipInterval: NodeJS.Timeout | null = null;

    constructor(
        public identityService: IdentityService,
        private blockchainService: BlockchainService
    ) { }

    public setContext(prisma: any) {
        this.prisma = prisma;
    }

    //------- Network Sync -------

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


            for (const peer of peers) {
                if (peer.name === this.identityService.nodeName) continue;

                try {
                    console.log(`[P2P] Syncing catalog with ${peer.name}...`);
                    const res = await axios.get(`${peer.endpoint}/api/catalog`, { timeout: 5000 });
                    if (res.status !== 200) continue;

                    const catalog: any[] = res.data;
                    for (const item of catalog) {
                        await this.processSyncedItem(item, peer);
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

    private async processSyncedItem(item: any, peer: WaraPeer) {
        if (!this.prisma) return;
        // STRATEGIC CHANGE: We ONLY sync things that are already in our Media table.
        // Our Media table is populated by the Blockchain (MediaService).
        // If it's not in the DB, it's NOT on-chain (or not a known proposal), so we SKIP it.
        let media = await this.prisma.media.findUnique({
            where: { waraId: item.waraId }
        });

        if (!media) {
            // console.log(`[P2P] Skipping untrusted/unregistered content: ${item.title}`);
            return;
        }

        // 1. "DATA" SYNC: If we have the skeleton but no rich data (overview/posters), fill it from Peer
        if (!media.overview || !media.posterPath) {
            try {
                const mediaRes = await axios.get(`${peer.endpoint}/api/media/stream/${item.waraId}`, { timeout: 3000 });
                if (mediaRes.status === 200) {
                    const remoteMedia = mediaRes.data;
                    media = await this.prisma.media.update({
                        where: { waraId: media.waraId },
                        data: {
                            overview: remoteMedia.overview,
                            posterPath: remoteMedia.posterPath,
                            backdropPath: remoteMedia.backdropPath,
                            genre: remoteMedia.genre,
                            releaseDate: remoteMedia.releaseDate,
                            extendedInfo: remoteMedia.extendedInfo
                        }
                    });

                    // Background Image Sync
                    this.syncImagesFromPeer(peer, media).catch(() => { });
                }
            } catch (e) {
                // peer might not have the manifest file
            }
        }

        if (media) {
            const storageAuthority = peer.name;
            const existingLink = await this.prisma.link.findUnique({
                where: { id: item.id || `${storageAuthority}_${media.waraId}` }
            });

            if (!existingLink) {
                await this.prisma.link.create({
                    data: {
                        id: item.id || `${storageAuthority}_${media.waraId}`, // Use peer's link ID if available
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
            } else {
                // Update existing link from peer
                await this.prisma.link.update({
                    where: { id: existingLink.id },
                    data: {
                        url: storageAuthority,
                        updatedAt: new Date()
                    }
                });
            }
        }
    }

    private async syncImagesFromPeer(peer: WaraPeer, media: any) {
        const sourceId = media.sourceId;
        const postersDir = path.join(CONFIG.DATA_DIR, 'posters');
        const backdropsDir = path.join(CONFIG.DATA_DIR, 'backdrops');

        const posterDest = path.join(postersDir, `${sourceId}.jpg`);
        const backdropDest = path.join(backdropsDir, `${sourceId}.jpg`);

        if (!fs.existsSync(postersDir)) fs.mkdirSync(postersDir, { recursive: true });
        if (!fs.existsSync(backdropsDir)) fs.mkdirSync(backdropsDir, { recursive: true });

        if (!fs.existsSync(posterDest)) {
            try {
                const imgRes = await axios.get(`${peer.endpoint}/api/catalog/poster/${sourceId}`, { timeout: 5000, responseType: 'stream' });
                if (imgRes.status === 200) imgRes.data.pipe(fs.createWriteStream(posterDest));
            } catch (e) { }
        }

        if (!fs.existsSync(backdropDest)) {
            try {
                const imgRes = await axios.get(`${peer.endpoint}/api/catalog/backdrop/${sourceId}`, { timeout: 5000, responseType: 'stream' });
                if (imgRes.status === 200) imgRes.data.pipe(fs.createWriteStream(backdropDest));
            } catch (e) { }
        }
    }

    //------- Peers Service -------

    // load directory peers.json
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

    // save directory peers.json
    public savePeers() {
        try {
            const pPath = path.join(CONFIG.DATA_DIR, 'peers.json');
            const data = Array.from(this.knownPeers.values());
            fs.writeFileSync(pPath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.warn('[P2P] Failed to load peers:', e);
        }
    }

    // for verify peer identity from registry
    public async verifyPeerIdentity(name: string, endpoint: string, signature?: string): Promise<{ address: string } | null> {
        if (!signature || !name || !endpoint) return null;
        try {
            // 1. Resolve from Registry
            let nodeAddress = ethers.ZeroAddress;
            let active = false;

            if (this.blockchainService.nodeRegistry) {
                const cleanName = name.replace('.wara', '');
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

    //------- Gossip Service -------

    public startGossip() {
        this.gossipInterval = setInterval(async () => {
            const peers = Array.from(this.knownPeers.values());
            if (peers.length === 0) return;

            // Random Fanout
            const targets = peers.sort(() => 0.5 - Math.random()).slice(0, 3);
            const myPayload = await this.buildGossipPayload(peers);

            for (const target of targets) {
                try {
                    await axios.post(`${target.endpoint}/api/network/gossip`, myPayload);
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

    // ------ Tracker service ------

    // load directory trackers.json
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
    // save directory trackers.json
    public saveTrackers() {
        try {
            const tPath = path.join(CONFIG.DATA_DIR, 'trackers.json');
            fs.writeFileSync(tPath, JSON.stringify(this.trackers, null, 2));
        } catch (e) {
            console.warn('[P2P] Failed to load trackers:', e);
        }
    }
    // get trackers
    public getTrackers(): string[] {
        return this.trackers;
    }
    // add tracker
    public addTracker(url: string) {
        if (!this.trackers.includes(url)) {
            this.trackers.push(url);
            this.saveTrackers();
        }
    }
    // remove tracker
    public removeTracker(url: string) {
        this.trackers = this.trackers.filter(t => t !== url);
        this.saveTrackers();
    }

    public startTrackerbeat() {
        // Stop existing
        if (this.trackerbeatInterval) clearInterval(this.trackerbeatInterval);

        // HTTP Announce to Trackers
        this.trackerbeatInterval = setInterval(async () => {
            if (this.trackers.length === 0) return;

            // NOTE: In full implementation, we'd inject stats from other services here
            const payload = {
                nodeId: this.identityService.nodeSigner?.address || 'unknown',
                endpoint: `http://${this.identityService.publicIp || 'localhost'}:${CONFIG.PORT}`,
                stats: { overloaded: false } // placeholder
            };

            for (const t of this.trackers) {
                try {
                    await axios.post(`${t}/announce`, payload);
                } catch (e) { }
            }
        }, 30000);
    }
    // discover from trackers
    private async discoverFromTrackers() {
        for (const tracker of this.trackers) {
            try {
                const res = await axios.get(`${tracker}/api/network/peers`);
                if (res.status === 200) {
                    const data: any = res.data;
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

    //--------SENTINEL SERVICE--------

    // bootstrap from sentinel for discovery nodes of registry
    private async bootstrapFromSentinel() {
        if (!this.blockchainService.nodeRegistry) return;
        try {
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

    // for resolve node ip from registry
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

    //--------END SENTINEL SERVICE--------

    public async init() {
        this.loadPeers();
        this.loadTrackers();

        // Initial Bootstrap
        await this.syncNetwork();

        // Start Background Jobs
        this.startTrackerbeat();
        this.startGossip();

        console.log(`[P2P] Initialized with ${this.knownPeers.size} peers and ${this.trackers.length} trackers.`);
    }

    public stop() {
        if (this.trackerbeatInterval) clearInterval(this.trackerbeatInterval);
        if (this.gossipInterval) clearInterval(this.gossipInterval);
    }
}
