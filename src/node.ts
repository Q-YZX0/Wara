import express, { Express } from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { WaraMap } from './types';
// @ts-ignore
import NatAPI from 'nat-api';
// @ts-ignore
import NetworkSpeed from 'network-speed';
import { ethers } from 'ethers';
import { PrismaClient } from '@prisma/client';
import {
    NODE_REGISTRY_ADDRESS, NODE_REGISTRY_ABI,
    SUBSCRIPTION_ADDRESS, SUBSCRIPTIONS_ABI,
    AD_MANAGER_ADDRESS, AD_MANAGER_ABI,
    MEDIA_REGISTRY_ADDRESS, MEDIA_REGISTRY_ABI,
    WARA_AIRDROP_ADDRESS, WARA_AIRDROP_ABI,
    WARA_DAO_ADDRESS, WARA_DAO_ABI,
    WARA_TOKEN_ADDRESS, ERC20_ABI
} from './contracts';
import { RPCManager } from './rpc-manager';
import { getMediaMetadata } from './tmdb';
import { setupAdsRoutes } from './routes/ads';
import { setupAuthRoutes } from './routes/auth';
import { setupAdminRoutes } from './routes/admin';
import { setupNetworkRoutes } from './routes/network';
import { setupCatalogRoutes } from './routes/catalog';
import { setupLinkRoutes } from './routes/link';
import { setupSubscriptionRoutes } from './routes/subscription';
import { setupStreamRoutes } from './routes/stream';
import { setupRegistryRoutes } from './routes/registry';
import { setupRemoteRoutes } from './routes/remote';
import { setupLeaderboardRoutes } from './routes/leaderboard';
import { setupOracleRoutes } from './routes/oracle';
import { setupWalletRoutes } from './routes/wallet';
import { setupMediaRoutes } from './routes/media';
import { setupAirdropRoutes } from './routes/airdrop';
import { setupDaoRoutes } from './routes/dao';
import { PriceOracleService } from './oracle-service';

export interface RegisteredLink {
    id: string;
    filePath: string;
    map: WaraMap;
    activeStreams: number;
    maxStreams: number;
    key?: string; // Stored key for P2P sharing
}

export class WaraNode {
    public app: Express;
    public prisma: PrismaClient;
    public links: Map<string, RegisteredLink> = new Map();
    public activeSessions: Map<string, number> = new Map(); // Store sessions (ip_linkId -> expiry)
    public port: number;
    private nat: any;
    private networkSpeed: any;
    public publicIp: string | null = null;

    // Discovery
    private trackers: string[] = [];
    private heartbeatInterval: NodeJS.Timeout | null = null;
    public nodeId: string;
    public region: string | null = null;

    // Resource Limits
    private minFreeRamMB = 500;

    // Capacity
    public globalMaxStreams = 10;

    // Storage
    public dataDir: string;

    public adminKey: string = '';
    public userSessions: Map<string, string> = new Map(); // AuthToken -> Username
    // Store unlocked wallets in memory related to session tokens
    // Note: In production, use HSM or secure enclave. For MVP/Local Node, memory is acceptable.
    public activeWallets: Map<string, any> = new Map(); // AuthToken -> ethers.Wallet
    public oracleService: PriceOracleService | null = null;

    public getAuthenticatedSigner(req: express.Request): ethers.Wallet | null {
        // 1. Check for Active User Session
        const authToken = (req.headers['x-auth-token'] || req.body.authToken) as string;
        if (authToken && this.activeWallets.has(authToken)) {
            return this.activeWallets.get(authToken);
        }

        // 2. Check for Admin Key (returns Technical Identity)
        const providedKey = req.headers['x-wara-key'] || req.body.adminKey;
        if (providedKey === this.adminKey && this.nodeSigner) {
            return this.nodeSigner;
        }

        // 3. Last chance: Localhost (returns Technical Identity for convenience)
        const remote = req.socket.remoteAddress;
        if (remote === '::1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1') {
            return this.nodeSigner;
        }

        return null;
    }


    public async getLocalUserWallet(address: string, password?: string): Promise<any> {
        try {
            const { decryptPrivateKey } = await import('./encryption');

            // 0. Check if it's the Technical Node Address
            if (this.nodeSigner && this.nodeSigner.address.toLowerCase() === address.toLowerCase()) {
                return this.nodeSigner;
            }

            // 1. Try to find local profile
            const profile = await this.prisma.localProfile.findUnique({
                where: { walletAddress: address }
            });

            if (profile && password) {
                try {
                    const privateKey = decryptPrivateKey(profile.encryptedPrivateKey, password);
                    return new ethers.Wallet(privateKey, this.provider);
                } catch (e) {
                    console.warn(`[WaraNode] Could not decrypt PK for ${address}. Check password.`);
                }
            }
        } catch (e) {
            console.error("[WaraNode] getLocalUserWallet error:", e);
        }
        return null;
    }

    // Agenda Distribuida (Nombre -> Endpoint)
    public knownPeers: Map<string, any> = new Map();
    public nodeName: string | null = null; // Nombre registrado en blockchain (ej: "salsa")
    public nodeSigner: ethers.Wallet | null = null; // Identidad delegada para firmar gossip
    public nodeOwner: string | null = null; // Wallet del operador (registrador)
    public chainId: number = 1;
    public rpcManager: RPCManager;
    public provider: ethers.JsonRpcProvider;
    public registryContract: ethers.Contract;
    public mediaRegistry: ethers.Contract;
    public subContract: ethers.Contract;
    public adManager: ethers.Contract;
    public airdropContract: ethers.Contract;
    public daoContract: ethers.Contract;
    public tokenContract: ethers.Contract;
    private lastSyncedBlock: number = 0;
    private isChainSyncing: boolean = false;
    private chainSyncInterval: NodeJS.Timeout | null = null;
    public sentinelStatus: {
        lastCheck: number;
        lastSuccess: boolean;
        lastUpdateHash?: string;
        error?: string;
    } = { lastCheck: 0, lastSuccess: false };


    constructor(port: number = 21746, dataDir?: string) {
        this.app = express();
        this.prisma = new PrismaClient({
            datasources: {
                db: {
                    url: process.env.DATABASE_URL
                }
            }
        });

        // Blockchain Setup
        const rpcUrl = process.env.RPC_URL || 'https://rpc2.sepolia.org';
        this.rpcManager = new RPCManager(rpcUrl);
        this.provider = this.rpcManager.getProvider();

        // Initialize contracts (Read-Only first, connected to signer later)
        this.registryContract = new ethers.Contract(NODE_REGISTRY_ADDRESS, NODE_REGISTRY_ABI, this.provider);
        this.mediaRegistry = new ethers.Contract(MEDIA_REGISTRY_ADDRESS, MEDIA_REGISTRY_ABI, this.provider);
        this.subContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTIONS_ABI, this.provider);
        this.adManager = new ethers.Contract(AD_MANAGER_ADDRESS, AD_MANAGER_ABI, this.provider);
        this.airdropContract = new ethers.Contract(WARA_AIRDROP_ADDRESS, WARA_AIRDROP_ABI, this.provider);
        this.daoContract = new ethers.Contract(WARA_DAO_ADDRESS, WARA_DAO_ABI, this.provider);
        this.tokenContract = new ethers.Contract(WARA_TOKEN_ADDRESS, ERC20_ABI, this.provider);


        this.port = port;
        this.dataDir = dataDir || path.join(process.cwd(), 'wara_store');

        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }

        // Create directory for ad proofs
        const proofsDir = path.join(this.dataDir, 'proofs');
        if (!fs.existsSync(proofsDir)) {
            fs.mkdirSync(proofsDir, { recursive: true });
        }

        // Create image directories for P2P metadata
        const imageDirs = ['posters', 'backdrops', 'episode-stills'];
        for (const dir of imageDirs) {
            const fullPath = path.join(this.dataDir, dir);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
            }
        }

        // --- PHASE 4: Atomic Storage Setup ---
        const storageDirs = ['temp', 'permanent'];
        for (const dir of storageDirs) {
            const fullPath = path.join(this.dataDir, dir);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
            }
        }

        // --- Admin Key Setup ---
        const isLocalOnly = process.env.LOCAL_ONLY === 'true';
        const keyPath = path.join(this.dataDir, 'admin_key.secret');

        if (isLocalOnly) {
            console.log('\n[SECURITY] LOCAL_ONLY Mode Active.');
            console.log('[SECURITY] Remote Admin disabled. No admin_key.secret created.');
            // Generate a random in-memory key that nobody knows, effectively disabling key Auth
            this.adminKey = crypto.randomBytes(64).toString('hex');
        } else if (process.env.ADMIN_KEY) {
            this.adminKey = process.env.ADMIN_KEY;
            fs.writeFileSync(keyPath, this.adminKey);
            console.log(`\n[SECURITY] Admin Key: ${this.adminKey}`);
        } else if (fs.existsSync(keyPath)) {
            this.adminKey = fs.readFileSync(keyPath, 'utf-8').trim();
            console.log(`\n[SECURITY] Admin Key: ${this.adminKey}`);
        } else {
            this.adminKey = crypto.randomBytes(32).toString('hex');
            fs.writeFileSync(keyPath, this.adminKey);
            console.log(`\n[SECURITY] Admin Key: ${this.adminKey}`);
        }

        this.nat = new NatAPI();
        this.networkSpeed = new NetworkSpeed();
        this.nodeId = Math.random().toString(36).substring(7);
        this.loadNodeName();
        this.loadPeers();
        this.loadTrackers();

        this.setupMiddleware();
        this.setupRoutes();
        this.loadExistingLinks();

        // Async Initialization Sequence
        this.init();
    }

    private async init() {
        try {
            const network = await this.provider.getNetwork();
            this.chainId = Number(network.chainId);
            console.log(`[WaraNode] Connected to ChainID: ${this.chainId}`);
        } catch (e) {
            console.error("[WaraNode] Failed to detect ChainID, using 1");
        }

        await this.detectRegion(); // Wait for IP/Region
        this.startSentinelCron();
        this.startGarbageCollector(); // Start cleanup of stale uploads

        // Start Blockchain Sync
        this.syncMediaFromChain();

        if (this.nodeName) {
            // Initial Peer Sync
            this.syncNetwork();
        }

        // Initialize Price Oracle DON Participant
        this.oracleService = new PriceOracleService(this);
        this.oracleService.start().catch(e => console.error("[Oracle] Failed to start:", e));
    }

    private loadNodeName() {
        const idPath = path.join(this.dataDir, 'node_identity.json');

        if (fs.existsSync(idPath)) {
            let identity;
            try {
                const fileContent = fs.readFileSync(idPath, 'utf-8');
                if (!fileContent.trim()) throw new Error("Empty file");
                identity = JSON.parse(fileContent);
                // Check if the object is empty
                if (Object.keys(identity).length === 0) throw new Error("Empty JSON object");
            } catch (e) {
                console.log(`[WaraNode] Identity file empty or invalid. Regenerating...`);
                identity = null;
            }

            if (identity) {
                if (identity.name) this.nodeName = identity.name;
                console.log(`[WaraNode] Loaded Named Identity: ${this.nodeName}`);
            } else {
                console.log(`[WaraNode] Loaded Anonymous Identity (Unregistered)`);
            }

            // Initialize Signer with the Delegated Node Key
            try {
                this.nodeSigner = new ethers.Wallet(identity.nodeKey, this.provider);
                this.nodeOwner = identity.owner || null; // Cargar dueño si existe

                // Connect contracts to this signer
                this.registryContract = this.registryContract.connect(this.nodeSigner) as any;
                this.subContract = this.subContract.connect(this.nodeSigner) as any;
                this.adManager = this.adManager.connect(this.nodeSigner) as any;
                this.airdropContract = this.airdropContract.connect(this.nodeSigner) as any;
                this.daoContract = this.daoContract.connect(this.nodeSigner) as any;
                this.tokenContract = this.tokenContract.connect(this.nodeSigner) as any;

                console.log(`[WaraNode] Signing Address: ${this.nodeSigner.address}`);
                if (this.nodeOwner) console.log(`[WaraNode] Node Owner: ${this.nodeOwner}`);
            } catch (e) {
                console.error("[WaraNode] Invalid Node Key in node_identity.json");
            }
        } else {
            // 1. Generate new Technical Identity on first boot
            console.log(`[WaraNode] No identity found. Generating new Technical Wallet...`);
            const techWallet = ethers.Wallet.createRandom();

            const identityData = {
                name: "", // Will be filled during registration
                nodeKey: techWallet.privateKey,
                registeredAt: 0,
                txHash: "",
                owner: ""
            };

            fs.writeFileSync(idPath, JSON.stringify(identityData, null, 2));
            this.nodeSigner = new ethers.Wallet(techWallet.privateKey, this.provider);
            this.nodeOwner = null; // Explicitly null

            // Connect contracts
            this.registryContract = this.registryContract.connect(this.nodeSigner) as any;
            this.mediaRegistry = this.mediaRegistry.connect(this.nodeSigner) as any;
            this.subContract = this.subContract.connect(this.nodeSigner) as any;
            this.adManager = this.adManager.connect(this.nodeSigner) as any;
            this.airdropContract = this.airdropContract.connect(this.nodeSigner) as any;
            this.daoContract = this.daoContract.connect(this.nodeSigner) as any;
            this.tokenContract = this.tokenContract.connect(this.nodeSigner) as any;

            console.log(`[WaraNode] New Technical Identity created: ${this.nodeSigner.address}`);
        }
    }

    private loadPeers() {
        const peersPath = path.join(this.dataDir, 'peers.json');
        if (fs.existsSync(peersPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(peersPath, 'utf8'));
                if (data && typeof data === 'object') {
                    Object.entries(data).forEach(([name, peer]: [string, any]) => {
                        this.knownPeers.set(name, {
                            ...peer,
                            lastSeen: new Date(peer.lastSeen).getTime() || Date.now()
                        });
                    });
                    console.log(`[WaraNode] Loaded ${this.knownPeers.size} peers from peers.json`);
                }
            } catch (e) {
                console.error("[WaraNode] Failed to load peers.json:", e);
            }
        }
    }

    public savePeers() {
        try {
            const peersPath = path.join(this.dataDir, 'peers.json');
            const data = Object.fromEntries(this.knownPeers);
            fs.writeFileSync(peersPath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error("[WaraNode] Failed to save peers.json:", e);
        }
    }

    private loadTrackers() {
        const trackersPath = path.join(this.dataDir, 'trackers.json');
        if (fs.existsSync(trackersPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(trackersPath, 'utf8'));
                if (Array.isArray(data)) {
                    // Merge with existing trackers from CLI
                    this.trackers = Array.from(new Set([...this.trackers, ...data]));
                    console.log(`[WaraNode] Loaded ${data.length} trackers from trackers.json`);
                }
            } catch (e) {
                console.error("[WaraNode] Failed to load trackers.json:", e);
            }
        }
    }

    public saveTrackers() {
        try {
            const trackersPath = path.join(this.dataDir, 'trackers.json');
            fs.writeFileSync(trackersPath, JSON.stringify(this.trackers, null, 2));
        } catch (e) {
            console.error("[WaraNode] Failed to save trackers.json:", e);
        }
    }

    public getTrackers(): string[] {
        return this.trackers;
    }

    public addTracker(url: string) {
        if (!this.trackers.includes(url)) {
            this.trackers.push(url);
            this.saveTrackers();
            console.log(`[WaraNode] Added new tracker: ${url}`);
        }
    }

    public removeTracker(url: string) {
        this.trackers = this.trackers.filter(t => t !== url);
        this.saveTrackers();
        console.log(`[WaraNode] Removed tracker: ${url}`);
    }

    private setupMiddleware() {
        this.app.use(cors({ origin: '*' })); // Allow all for MVP
        this.app.use(express.json());

        // Security Middleware: LOCAL_ONLY Mode
        if (process.env.LOCAL_ONLY === 'true') {
            this.app.use((req, res, next) => {
                const ip = req.ip || req.socket.remoteAddress || '';
                const isLocal = ip === '::1' || ip.includes('127.0.0.1') || ip === 'localhost';

                // Block sensitive paths from external IPs
                // allow /api/catalog, /stream/ (streaming)
                const sensitivePaths = ['/api/auth/', '/api/wallet/', '/admin/', '/api/remote-nodes'];
                const isSensitive = sensitivePaths.some(p => req.path.startsWith(p));

                if (isSensitive && !isLocal) {
                    console.warn(`[SECURITY] Blocked external access to ${req.path} from ${ip}`);
                    return res.status(403).json({ error: 'Remote administration Disabled (LOCAL_ONLY)' });
                }
                next();
            });
        }

        // Log all requests for debugging
        this.app.use((req, res, next) => {
            if (!req.url.startsWith('/admin/status')) {
                console.log(`[WaraNode] INCOMING: ${req.method} ${req.url} (from ${req.ip})`);
            }
            next();
        });
    }

    private loadExistingLinks() {
        if (!fs.existsSync(this.dataDir)) return;

        console.log(`[WaraNode] Scanning ${this.dataDir} for content and ads...`);

        const scanDir = (dir: string, isAd: boolean = false) => {
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    // SKIP SYSTEM FILES
                    if (['peers.json', 'trackers.json', 'node_identity.json', 'package.json', 'tsconfig.json'].includes(file)) continue;

                    try {
                        const fullPath = path.join(dir, file);
                        const mapData = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

                        // Check if corresponding .wara file exists (Legacy Root OR Permanent Folder)
                        const encryptedPath = path.join(dir, `${mapData.id}.wara`);
                        if (fs.existsSync(encryptedPath)) {
                            this.registerLink(mapData.id, encryptedPath, mapData, mapData.key);
                        }
                    } catch (e) {
                        console.error(`[WaraNode] Failed to restore link from ${file}:`, e);
                    }
                }
            }
        };

        // Scan main store (Legacy)
        scanDir(this.dataDir);

        // Scan Permanent store (Phase 4)
        scanDir(path.join(this.dataDir, 'permanent'));

        // Scan ads subfolder
        const adsDir = path.join(this.dataDir, 'ads');
        scanDir(adsDir, true);

        console.log(`[WaraNode] Total Links Active: ${this.links.size}`);
    }

    private startGarbageCollector() {
        const tempDir = path.join(this.dataDir, 'temp');
        if (!fs.existsSync(tempDir)) return;

        setInterval(() => {
            console.log(`[WaraNode] [GC] Checking for stale temp uploads...`);
            try {
                const files = fs.readdirSync(tempDir);
                const now = Date.now();
                const threshold = 24 * 60 * 60 * 1000; // 24 hours

                files.forEach(file => {
                    const filePath = path.join(tempDir, file);
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtimeMs > threshold) {
                        console.log(`[WaraNode] [GC] Removing stale upload: ${file}`);
                        fs.unlinkSync(filePath);
                    }
                });
            } catch (e) {
                console.error("[WaraNode] [GC] Error:", e);
            }
        }, 60 * 60 * 1000); // Check every hour
    }

    private startGovernanceJob() {
        console.log("[WaraNode] Starting Governance (DAO Executor) Job...");
        setInterval(async () => {
            try {
                // 1. Find Expired Proposals
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

                console.log(`[Governance] Analyzing ${pendingProposals.length} expired proposals...`);

                const OWNER_PK = process.env.OWNER_PRIVATE_KEY;
                if (!OWNER_PK) {
                    console.warn("[Governance] No Owner Private Key found. Cannot execute DAO decisions.");
                    return;
                }

                // Initialize Executor Wallet
                const executorWallet = new ethers.Wallet(OWNER_PK, this.provider);
                const registryWrite = new ethers.Contract(MEDIA_REGISTRY_ADDRESS, MEDIA_REGISTRY_ABI, executorWallet);

                for (const proposal of pendingProposals) {
                    const margin = proposal.upvotes - proposal.downvotes;

                    if (margin > 0) {
                        try {
                            console.log(`[Governance] 🟢 Proposal PASSED: ${proposal.title} (Margin: +${margin}). Executing Blessing...`);

                            // Check if already on chain to avoid revert
                            const [exists] = await registryWrite.exists(proposal.source, proposal.sourceId);
                            if (exists) {
                                console.log(`[Governance] Skipped Transaction: Already on-chain.`);
                            } else {
                                // Prepare Batch Data (Consensus)
                                const voters = proposal.votes.map((v: any) => v.voterWallet);
                                const votes = proposal.votes.map((v: any) => v.value);
                                const signatures = proposal.votes.map((v: any) => v.signature);

                                console.log(`[Governance] Submitting ${voters.length} signatures to chain...`);

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
                                console.log(`[Governance] Execution Confirmed: ${tx.hash}`);
                            }

                            // Update DB
                            await this.prisma.media.update({
                                where: { waraId: proposal.waraId },
                                data: { status: 'approved' }
                            });

                        } catch (e: any) {
                            console.error(`[Governance] Execution Failed for ${proposal.title}:`, e.message);
                        }
                    } else {
                        console.log(`[Governance] 🔴 Proposal REJECTED: ${proposal.title} (Margin: ${margin}). Rejecting...`);
                        await this.prisma.media.update({
                            where: { waraId: proposal.waraId },
                            data: { status: 'rejected' }
                        });

                        // Burn manifest
                        const manifestPath = path.join(this.dataDir, 'media', `${proposal.waraId}.json`);
                        if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
                    }
                }

            } catch (e: any) {
                console.error("[Governance] Job Error:", e.message);
            }
        }, 60 * 60 * 1000); // Check every hour
    }

    public requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const remote = req.socket.remoteAddress;
        const providedKey = req.headers['x-wara-key'];

        // 1. Admin Key Bypass (Superuser) - Works from Remote or Local
        if (providedKey === this.adminKey) {
            return next();
        }

        // 2. Strict Localhost Check
        const isLocal = remote === '::1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1';

        if (isLocal) {
            // Localhost requires Active User Session (Login) OR Admin Key
            // We already checked Admin Key above. So now we check for Session.
            const authToken = (req.headers['x-auth-token'] || req.headers['x-wara-token']) as string;

            // Check if token exists and is valid in activeWallets (Full Wallet Session) or userSessions (Light Session)
            if (authToken && (this.activeWallets.has(authToken) || this.userSessions.has(authToken))) {
                return next();
            }

            // Allow /admin/status to pass on Localhost without auth for identifying "Locked" state
            // This is critical for the Dashboard to show the "Connect Wallet" screen instead of a network error.
            if (req.path === '/api/admin/status' || req.originalUrl.includes('/admin/status')) {
                return next();
            }

            console.warn(`[WaraNode] Localhost admin attempt blocked. No active session.`);
            return res.status(401).json({ error: 'Local Admin requires Login' });
        }

        // 3. Block Remote without Key
        console.warn(`[WaraNode] Blocked unauthorized admin attempt from ${remote}`);
        res.status(403).json({ error: 'Access denied. Valid Admin Key required.' });
    }

    public isSystemOverloaded(): boolean {
        const freeMemMB = os.freemem() / 1024 / 1024;
        if (freeMemMB < this.minFreeRamMB) {
            return true;
        }
        const cpus = os.cpus().length;
        const load = os.loadavg()[0];
        if (load > cpus * 0.8) {
            return true;
        }
        return false;
    }

    private setupRoutes() {
        this.app.get('/', (req: express.Request, res: express.Response) => {
            res.json({
                service: 'WaraNode',
                version: '0.1.0',
                status: 'running',
                nodeId: this.nodeId,
                links: this.links.size,
                publicIp: this.publicIp,
                capacity: this.globalMaxStreams,
                system: {
                    freeMem: Math.round(os.freemem() / 1024 / 1024) + 'MB',
                    load: os.loadavg()
                }
            });
        });
        // AD MODULE ROUTES (Refactored)
        this.app.use('/api/ad', setupAdsRoutes(this));
        // AUTH & USER MODULE (Refactored)
        this.app.use('/api/auth', setupAuthRoutes(this));
        // ADMIN ROUTES
        this.app.use('/api/admin', setupAdminRoutes(this));
        // NETWORK & DISCOVERY
        this.app.use('/api/network', setupNetworkRoutes(this));
        // CATALOG & MEDIA
        this.app.use('/api/catalog', setupCatalogRoutes(this));
        // LINKS
        this.app.use('/api/links', setupLinkRoutes(this));
        // STREAMS & PLAYBACK
        this.app.use('/api/stream', setupStreamRoutes(this));
        // REGISTRY (Identity)
        this.app.use('/api/registry', setupRegistryRoutes(this));
        // REMOTE NODES
        this.app.use('/api/remote', setupRemoteRoutes(this));
        // LEADERBOARD
        this.app.use('/api/leaderboard', setupLeaderboardRoutes(this));
        // ORACLE (Smart Committee)
        this.app.use('/api/oracle', setupOracleRoutes(this));
        // ColdWallet Profile(userSigner)
        this.app.use('/api/wallet', setupWalletRoutes(this));
        // Setup Media Registry Routes
        this.app.use('/api/media', setupMediaRoutes(this));
        // SUBSCRIPTION
        this.app.use('/api/subscription', setupSubscriptionRoutes(this));
        // AIRDROP & DAO
        this.app.use('/api/airdrop', setupAirdropRoutes(this));
        this.app.use('/api/dao', setupDaoRoutes(this));
    }

    public registerLink(id: string, encryptedFilePath: string, map: WaraMap, key?: string) {
        if (!fs.existsSync(encryptedFilePath)) throw new Error(`File not found: ${encryptedFilePath} `);
        this.links.set(id, {
            id,
            filePath: encryptedFilePath,
            map,
            activeStreams: 0,
            maxStreams: this.globalMaxStreams,
            key: key // Store Key in memory if provided
        });
        console.log(`[WaraNode] Registered link: ${map.title} (${id})`);
    }

    private async runBenchmark() {
        console.log(`[WaraNode] Running Network Benchmark(Upload Speed)...`);
        try {
            const baseUrl = 'http://eu.httpbin.org/stream-bytes/500000';
            const dlSpeed = await this.networkSpeed.checkDownloadSpeed(baseUrl, 500000);
            const mbps = parseFloat(dlSpeed.mbps);
            const estimatedUpload = mbps * 0.2;
            const capacity = Math.max(1, Math.floor(estimatedUpload / 5));
            this.globalMaxStreams = capacity;
            console.log(`[WaraNode] Auto - Configured Capacity: ${this.globalMaxStreams} (Est.${estimatedUpload.toFixed(2)} Mbps Up)`);
        } catch (e) {
            console.log(`[WaraNode] Benchmark failed.Using default capacity: ${this.globalMaxStreams} `);
        }
    }

    private async bootstrapFromSentinel() {
        // Fallback or Primary Discovery via Blockchain (Sentinel)
        try {
            const limit = 20; // Fetch last 20 nodes
            // Calling Smart Contract to get active nodes
            // Returns tuple of arrays [names[], ips[]]
            const res = await this.registryContract.getBootstrapNodes(limit);

            const names = res[0] || res.names;
            const ips = res[1] || res.ips;

            if (names && names.length > 0) {
                console.log(`[Sentinel] Bootstrapping: Found ${names.length} nodes on chain.`);
                for (let i = 0; i < names.length; i++) {
                    const name = names[i];
                    const ip = ips[i];
                    // Ensure we have our own name loaded
                    if (!this.nodeName) {
                        try {
                            const idPath = path.join(this.dataDir, 'node_identity.json');
                            if (fs.existsSync(idPath)) {
                                const id = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
                                if (id.name) this.nodeName = id.name;
                            }
                        } catch (e) { }
                    }

                    // Filter invalid or self (Normalize names to avoid muggi vs muggi.wara mismatch)
                    const cleanName = name.replace('.wara', '').replace('.muggi', '').trim().toLowerCase();
                    const cleanMyName = (this.nodeName || '').replace('.wara', '').replace('.muggi', '').trim().toLowerCase();

                    // Helper to check if IP is local/self
                    const isSelfIp = (targetIp: string) => {
                        if (!targetIp) return false;
                        // Check explicit Public IP (if known)
                        if (this.publicIp && targetIp.includes(this.publicIp)) return true;
                        // Check standard loopback
                        if (targetIp.includes('127.0.0.1') || targetIp.includes('localhost')) return true;

                        // Check ALL local interfaces
                        const nets = os.networkInterfaces();
                        for (const name of Object.keys(nets)) {
                            for (const net of nets[name]!) {
                                if (targetIp.includes(net.address)) return true;
                            }
                        }
                        return false;
                    };

                    if (name && ip && ip.startsWith('http')) {
                        // 1. Name Mismatch Check
                        if (cleanName === cleanMyName) {
                            // console.log(`[Sentinel] Skipped self (Name Logic): ${name}`);
                            continue;
                        }

                        // 2. IP Mismatch Check (Robust)
                        if (isSelfIp(ip)) {
                            // console.log(`[Sentinel] Skipped self (IP Logic): ${name}`);
                            continue;
                        }

                        // Only add if not known or update
                        if (!this.knownPeers.has(name)) {
                            // Query full node info to get nodeAddress
                            let nodeAddress = undefined;
                            try {
                                // Use failover for registry check
                                const onChainNode = await this.rpcManager.callWithFailover(async (provider) => {
                                    const contract = this.registryContract.connect(provider) as any;
                                    return await contract.getNode(name.replace('.wara', '')); // Query for the discovered peer 'name'
                                });
                                if (onChainNode && onChainNode.nodeAddress) {
                                    nodeAddress = onChainNode.nodeAddress;
                                }
                            } catch (e) {
                                console.warn(`[Sentinel] Could not fetch nodeAddress for ${name}`);
                            }

                            this.knownPeers.set(name, {
                                endpoint: ip,
                                nodeAddress, // Store technical wallet address
                                lastSeen: Date.now(),
                                signature: undefined // Untrusted until handshake
                            } as any);
                            console.log(`[Sentinel] Discovered new peer: ${name}${nodeAddress ? ` (${nodeAddress.slice(0, 10)}...)` : ''}`);
                        }
                    }
                }
            }
        } catch (e) {
            // console.warn('[Sentinel] Bootstrap query failed (Contract update required?)', e); 
        }
    }

    private isSyncing = false;

    private async syncNetwork() {
        if (this.isSyncing) {
            console.log('[WaraNode] Sync already in progress, skipping...');
            return;
        }
        this.isSyncing = true;

        // FAILSAFE: Ensure Public IP is known for filtering
        if (!this.publicIp) {
            try {
                // Use a different provider just in case ip-api is rate limiting or formatted differently
                const res = await fetch('https://api.ipify.org?format=json');
                const data = await res.json();
                this.publicIp = (data.ip || '').trim();
                console.log(`[WaraNode] Sync Failsafe: Resolved Public IP -> ${this.publicIp}`);
            } catch (e) {
                console.log('[WaraNode] Sync Failsafe: Could not resolve IP. Self-filtering might fail.');
            }
        }

        // Helper to check if IP is local/self (Explicitly inline here for safety)
        const isSelf = (target: string) => {
            if (!target) return false;
            // 1. Check Name matches (if passed as target, but here we check endpoint/IP mostly)

            // 2. Check Public IP
            if (this.publicIp && target.includes(this.publicIp)) return true;

            // 3. Check Loopback
            if (target.includes('127.0.0.1') || target.includes('localhost')) {
                if (target.includes(String(this.port))) return true;
            }
            return false;
        };

        console.log(`[WaraNode] Starting Global P2P Sync (IP: ${this.publicIp || 'Unknown'})...`);

        // 0. Sentinel Blockchain Bootstrap
        await this.bootstrapFromSentinel();

        try {
            // 1. Discover Peers from Trackers
            for (const tracker of this.trackers) {
                try {
                    const res = await fetch(`${tracker}/api/network/peers`);
                    if (!res.ok) continue;
                    const peers = await res.json();
                    for (const peer of (Array.isArray(peers) ? peers : peers.peers || [])) {
                        // FILTER: Skip Self immediately from Tracker
                        if (isSelf(peer.endpoint)) continue;

                        if (peer.endpoint && peer.name && peer.name !== this.nodeName) {

                            // Cryptographic Verification
                            const verified = await this.verifyPeerIdentity(peer.name, peer.endpoint, peer.signature);

                            this.knownPeers.set(peer.name, {
                                endpoint: peer.endpoint,
                                lastSeen: Date.now(),
                                signature: peer.signature,
                                walletAddress: verified?.address,
                                isTrusted: !!verified
                            } as any);

                            if (verified) {
                                console.log(`[Gossip] Verified Trusted Peer: ${peer.name} (${verified.address})`);
                            }

                            // Fallback if not verified
                            if (!this.knownPeers.has(peer.name)) {
                                this.knownPeers.set(peer.name, {
                                    endpoint: peer.endpoint,
                                    lastSeen: Date.now(),
                                    signature: peer.signature,
                                    isTrusted: false
                                } as any);
                            }
                        }
                    }
                } catch (e) { }
            }

            // 2. Sync Catalogs with known peers
            const peers = Array.from(this.knownPeers.entries()).slice(0, 10);
            for (const [name, data] of peers) {
                // GUARD: Prevent Self-Syncing loops
                if (name === this.nodeName) continue;

                // IP-based Self-Protection (Robust)
                const endpoint = data.endpoint || '';

                if (isSelf(endpoint)) {
                    // console.log(`[Sync] Removing self-peer zombie: ${name}`);
                    this.knownPeers.delete(name); // CLEANUP
                    continue;
                }

                try {
                    console.log(`[WaraNode] Syncing catalog with ${name} (${data.endpoint})...`);
                    const res = await fetch(`${data.endpoint}/api/catalog`, { signal: AbortSignal.timeout(5000) });
                    if (!res.ok) continue;
                    const catalog = await res.json();

                    for (const item of catalog) {
                        const sourceId = item.sourceId;
                        const source = item.source || 'tmdb';
                        const mediaType = item.mediaType || 'movie';

                        if (!sourceId) continue;

                        let media = await this.prisma.media.findUnique({
                            where: { source_sourceId: { source, sourceId } }
                        });

                        // --- SOVEREIGN METADATA DISCOVERY (P2P) ---
                        // If we don't have the media, or it's not TMDB, try to fetch from the peer first
                        if (!media) {
                            try {
                                const waraId = item.waraId || (mediaType === 'episode' ? null : ethers.solidityPackedKeccak256(["string", "string"], [source, `:${sourceId}`]));
                                if (waraId) {
                                    console.log(`[WaraNode] Discovery: Fetching Sovereign Metadata for ${sourceId} from ${data.endpoint}...`);
                                    const mediaRes = await fetch(`${data.endpoint}/api/media/stream/${waraId}`, { signal: AbortSignal.timeout(3000) });
                                    if (mediaRes.ok) {
                                        const remoteMedia = await mediaRes.json();
                                        media = await this.prisma.media.upsert({
                                            where: { waraId: remoteMedia.waraId },
                                            update: { ...remoteMedia },
                                            create: { ...remoteMedia }
                                        });

                                        // --- P2P IMAGE SYNC ---
                                        // Use existing endpoints to copy images directly from peer
                                        const postersDir = path.join(this.dataDir, 'posters');
                                        const postersDest = path.join(postersDir, `${sourceId}.jpg`);
                                        if (!fs.existsSync(postersDest)) {
                                            if (!fs.existsSync(postersDir)) fs.mkdirSync(postersDir, { recursive: true });
                                            fetch(`${data.endpoint}/api/catalog/poster/${sourceId}`).then(res => {
                                                if (res.ok) {
                                                    const dest = fs.createWriteStream(postersDest);
                                                    (res.body as any).pipe(dest);
                                                }
                                            }).catch(() => { });
                                        }

                                        console.log(`[WaraNode] Successfully synced Sovereign Media: ${media.title}`);
                                    }
                                }
                            } catch (e) { }
                        }

                        if (!media) {
                            console.log(`[WaraNode] Auto-Discovery: Enriching ${sourceId} from ${source} via TMDB...`);
                            if (source === 'tmdb') {
                                media = await getMediaMetadata(this.prisma, sourceId, mediaType);
                            }
                        }

                        // Identity: TMDB ID + Uploader Wallet (Invariant)
                        let existingLink = null;

                        // STORE HOST AUTHORITY ONLY (Pragmatic Reuse of URL field)
                        // We store the Peer Name (or Address) in the 'url' field.
                        // The full URL will be constructed at runtime: http://<host>/stream/<id>
                        // Assumption: Local ID matches Remote ID for the same Link record.
                        const storageAuthority = name;

                        // Check existence based on this authority + SourceID + Wallet (Exact Replica check)
                        // Note: We need media to be defined to match sourceId. If no media, we can't reliably match by content ID here.
                        if (media) {
                            const m = media;
                            existingLink = await this.prisma.link.findFirst({
                                where: {
                                    url: storageAuthority,
                                    sourceId: m.sourceId,
                                    uploaderWallet: item.uploaderWallet
                                }
                            });
                        } else {
                            // Fallback: If we don't have media metadata yet, try to match by URL only?
                            // Or just skip exact matching.
                            existingLink = await this.prisma.link.findFirst({
                                where: { url: storageAuthority }
                            });
                        }

                        if (!existingLink) {
                            // If not found, check loosely by uploader wallet and content to see if we need to update the host
                            if (item.uploaderWallet && media) {
                                const mn = media;
                                existingLink = await this.prisma.link.findFirst({
                                    where: {
                                        sourceId: mn.sourceId,
                                        source: mn.source,
                                        uploaderWallet: item.uploaderWallet
                                    }
                                });
                            }
                        }

                        if (existingLink) {
                            // UPDATE: Ensure virtual schema (Host Authority)
                            if (existingLink.url !== storageAuthority) {
                                await this.prisma.link.update({
                                    where: { id: existingLink.id },
                                    data: { url: storageAuthority }
                                });
                                // console.log(`[Sync] Updated Link Schema for ${item.title}`);
                            }
                        } else if (media) {
                            // CREATE with Virtual URL (Host Authority)
                            // Note: 'item' details (metadata) are preserved
                            await this.prisma.link.create({
                                data: {
                                    url: storageAuthority, // Stores Host ID
                                    title: item.title || `[P2P] ${media.title}`,
                                    waraId: media.waraId,
                                    source: media.source,
                                    sourceId: media.sourceId,
                                    mediaType: media.type,
                                    uploaderWallet: item.uploaderWallet,
                                    trustScore: 10,
                                    waraMetadata: item.waraMetadata
                                }
                            });
                        }
                    }
                } catch (e) {
                    console.warn(`[WaraNode] Sync failed with ${name}:`, e);
                }
            }

            // Persist discovered peers
            this.savePeers();
        } catch (e) {
            console.error("[WaraNode] Global Sync Error", e);
        } finally {
            this.isSyncing = false;
        }
    }

    private getLocalIp(): string {
        try {
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                if (!interfaces[name]) continue;
                for (const iface of interfaces[name]!) {
                    // Skip internal (i.e. 127.0.0.1) and non-ipv4
                    if ('IPv4' !== iface.family || iface.internal) {
                        continue;
                    }
                    return iface.address;
                }
            }
        } catch (e) { }
        return '127.0.0.1';
    }

    private startHeartbeat() {
        const beat = async () => {
            // Fix: Allow running without Public IP (Local Network Mode)
            const ip = this.publicIp || this.getLocalIp();
            const endpoint = `http://${ip}:${this.port}`;

            const payload = {
                nodeId: this.nodeId,
                endpoint: endpoint,
                stats: {
                    capacity: this.globalMaxStreams,
                    load: Array.from(this.links.values()).reduce((a, b) => a + (b.activeStreams || 0), 0),
                    overloaded: this.isSystemOverloaded()
                },
                content: Array.from(this.links.keys())
            };

            if (this.trackers.length > 0) {
                for (const trackerUrl of this.trackers) {
                    try {
                        const cleanUrl = trackerUrl.replace(/\/$/, '');
                        await fetch(`${cleanUrl}/announce`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                    } catch (e) {
                        // console.warn(`[Hearbeat] Failed to announce to ${trackerUrl}`);
                    }
                }
            }

            let mySignature = "";
            if (this.nodeSigner) {
                // If it doesn't have a name yet, sign using the technical address
                const identifier = this.nodeName || this.nodeSigner.address;
                const message = `WaraNode:${identifier}:${endpoint}`;
                mySignature = await this.nodeSigner.signMessage(message);
            }

            const gossipPayload = {
                peers: [
                    {
                        name: this.nodeName || this.nodeSigner?.address || `Node_${this.nodeId}`,
                        endpoint: endpoint,
                        signature: mySignature,
                        nodeId: this.nodeId
                    },
                    ...Array.from(this.knownPeers.entries())
                        .slice(0, 5)
                        .map(([name, data]) => ({
                            name,
                            endpoint: data.endpoint,
                            signature: data.signature
                        }))
                ]
            };

            const connectedPeers = Array.from(this.knownPeers.values());
            if (connectedPeers.length > 0) {
                const targets = connectedPeers.sort(() => 0.5 - Math.random()).slice(0, 3);
                for (const p of targets) {
                    try {
                        await fetch(`${p.endpoint}/api/network/gossip`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(gossipPayload)
                        });
                    } catch (e) { }
                }
            }
        };
        this.heartbeatInterval = setInterval(beat, 30000);
        beat();

        setInterval(() => this.syncNetwork(), 5 * 60 * 1000);
        setTimeout(() => this.syncNetwork(), 5000);
    }

    public stop() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    }

    public async start() {
        // Benchmark
        if (!process.env.SKIP_BENCHMARK) {
            await this.runBenchmark();
        } else {
            console.log('[WaraNode] Skipping Benchmark (Env set)');
        }

        // UPnP
        // UPnP
        const isLocalOnly = process.env.LOCAL_ONLY === 'true';
        if (!process.env.SKIP_UPNP) {
            console.log(`[WaraNode] Attempting UPnP port mapping for ${this.port}...`);
            try {
                const upnpPromise = new Promise<void>((resolve, reject) => {
                    this.nat.map(this.port, (err: any) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                // Timeout after 5 seconds
                const timeoutPromise = new Promise<void>((_, reject) => {
                    setTimeout(() => reject(new Error('UPnP Timed out')), 5000);
                });

                await Promise.race([upnpPromise, timeoutPromise]);

                this.publicIp = await new Promise<string>((resolve) => {
                    this.nat.externalIp((err: any, ip: string) => { resolve(ip); });
                });
                if (this.publicIp) console.log(`[WaraNode] Public IP detected: ${this.publicIp}`);
            } catch (e) {
                console.warn(`[WaraNode] UPnP Warning: ${(e as Error).message}. Continuing without port forwarding...`);
            }
        } else {
            console.log('[WaraNode] Skipping UPnP (Env set)');
        }

        // Geo Region
        try {
            console.log(`[WaraNode] Detecting Region...`);
            // @ts-ignore
            const fetch = (await import('node-fetch')).default;
            const geoRes = await fetch('http://ip-api.com/json/');
            const geo: any = await geoRes.json();
            if (geo.status === 'success') {
                this.region = geo.countryCode;
                console.log(`[WaraNode] Region Detected: ${this.region}`);
            }
        } catch (e) {
            console.warn(`[WaraNode] Geo-detect failed: ${(e as Error).message}`);
        }

        // Listen
        this.app.listen(this.port, '0.0.0.0', async () => {
            console.log(`[WaraNode] Running on port ${this.port}`);
            console.log(`[WaraNode] ID: ${this.nodeId}`);

            // Start Sentinel Service Logic
            if (this.nodeSigner && this.nodeName) {
                this.startSentinelCron();
            } else {
                console.log('[Sentinel] No active identity found (node_identity.json). IP Monitoring disabled.');
            }

            this.startHeartbeat();
            this.startGossip();
        });
    }

    private startGossip() {
        console.log('[Gossip] Starting P2P Gossip Protocol (Active)...');
        // Gossip every 60 seconds
        setInterval(async () => {
            const peers = Array.from(this.knownPeers.entries());
            if (peers.length === 0) return;

            // 1. Select Random Targets (Fanout = 3)
            const fanout = 3;
            const targets = [];
            const tempPeers = [...peers]; // Copy to splice
            for (let i = 0; i < fanout; i++) {
                if (tempPeers.length === 0) break;
                const idx = Math.floor(Math.random() * tempPeers.length);
                targets.push(tempPeers[idx]);
                tempPeers.splice(idx, 1);
            }

            // 2. Prepare Payload (Myself + up to 10 random peers)
            const payload = peers
                .sort(() => 0.5 - Math.random())
                .slice(0, 10)
                .map(([name, data]) => ({
                    name,
                    endpoint: data.endpoint,
                    signature: data.signature
                }));

            // Add myself
            if (this.nodeSigner && this.publicIp) {
                const identifier = this.nodeName || this.nodeSigner.address;
                const endpoint = `http://${this.publicIp}:${this.port}`;
                const message = `WaraNode:${identifier}:${endpoint}`;
                const sig = await this.nodeSigner.signMessage(message);

                // Detect Local IP for LAN Optimization
                let localEndpoint = undefined;
                try {
                    const os = require('os');
                    const nets = os.networkInterfaces();
                    for (const name of Object.keys(nets)) {
                        for (const net of nets[name]!) {
                            if (net.family === 'IPv4' && !net.internal) {
                                localEndpoint = `http://${net.address}:${this.port}`;
                                break;
                            }
                        }
                        if (localEndpoint) break;
                    }
                } catch (e) { }

                payload.push({
                    name: identifier,
                    endpoint: endpoint,
                    signature: sig,
                    // @ts-ignore
                    localEndpoint: localEndpoint // Extra field for LAN discovery
                });
            }

            // 3. Send Gossip
            targets.forEach(([targetName, targetData]) => {
                // Skip self if localhost
                if (targetData.endpoint.includes(`:${this.port}`)) return;

                fetch(`${targetData.endpoint}/api/network/gossip`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ peers: payload })
                }).catch(() => {
                    // Silent fail is expected in P2P gossip
                });
            });

        }, 60 * 1000);
    }

    public async getResolvedCatalog() {
        // 1. Local Links (Hosting)
        const localItems = Array.from(this.links.values()).map(l => ({
            id: l.id,
            title: l.map.title,
            activeStreams: l.activeStreams,
            mediaInfo: l.map.mediaInfo,
            hosterAddress: l.map.hosterAddress,
            url: `http://${this.publicIp || 'localhost'}:${this.port}/stream/${l.id}${l.key ? '#' + l.key : ''}`
        }));

        // 2. P2P Links (Remote from DB)
        const remoteLinks = await this.prisma.link.findMany({
            select: { id: true, url: true, title: true, waraMetadata: true, uploaderWallet: true }
        });

        const p2pItems = await Promise.all(remoteLinks.map(async (link) => {
            let finalUrl = link.url;

            // RESOLVE PORTABLE URL: http://<nodeName>/stream/<id> -> http://<IP>:PORT/stream/<id>
            try {
                const url = new URL(link.url);
                const hostname = url.hostname;

                // Check if hostname is an IP address (already resolved)
                const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname === 'localhost';

                if (!isIpAddress) {
                    // Hostname is a nodeName or nodeAddress, need to resolve
                    const identifier = hostname;
                    let resolvedEndpoint: string | null = null;

                    // Check if it's the local node
                    const isLocalByName = identifier.includes('.wara') && this.nodeName && identifier === this.nodeName;
                    const isLocalByAddress = identifier.startsWith('0x') && (this as any).nodeAddress && (this as any).nodeAddress.toLowerCase() === identifier.toLowerCase();

                    if (isLocalByName || isLocalByAddress) {
                        resolvedEndpoint = `http://localhost:${this.port}`;
                    } else {
                        // STEP 1: Search in knownPeers first
                        for (const [peerName, peer] of this.knownPeers.entries()) {
                            const matchByName = identifier.includes('.wara') && peerName === identifier;
                            const matchByAddress = identifier.startsWith('0x') && peer.nodeAddress && peer.nodeAddress.toLowerCase() === identifier.toLowerCase();

                            if (matchByName || matchByAddress) {
                                resolvedEndpoint = peer.endpoint;
                                break;
                            }
                        }

                        // STEP 2: If not in cache and it's a .wara name, query blockchain
                        if (!resolvedEndpoint && identifier.includes('.wara')) {
                            const resolvedIp = await this.resolveSentinelNode(identifier);
                            if (resolvedIp) {
                                resolvedEndpoint = resolvedIp;
                            }
                        }
                    }

                    if (resolvedEndpoint) {
                        // Replace hostname with resolved endpoint
                        finalUrl = link.url.replace(`http://${identifier}`, resolvedEndpoint);
                    }
                }
            } catch (e) { }

            return {
                id: link.id,
                title: link.title,
                activeStreams: 0,
                mediaInfo: link.waraMetadata ? (JSON.parse(link.waraMetadata as string)) : {},
                hosterAddress: link.uploaderWallet,
                url: finalUrl
            };
        }));

        // Merge (Filter duplicates by ID if needed, but DB vs Memory usually disjoint)
        const seen = new Set(localItems.map(i => i.id));
        const uniqueP2P = p2pItems.filter(i => !seen.has(i.id));

        return [...localItems, ...uniqueP2P];
    }

    public async verifyPeerIdentity(name: string, endpoint: string, signature?: string): Promise<{ address: string } | null> {
        if (!signature || !name || !endpoint) return null;
        try {
            // 1. Resolve name from Muggi Registry (.wara handling)
            const cleanName = name.replace('.wara', '');
            const info = await this.registryContract.getNode(cleanName);

            // info format: [operator, nodeAddress, expiresAt, active, currentIP] 
            if (info.active && info.nodeAddress !== ethers.ZeroAddress) {
                // 2. Verify technical node signature (not operator)
                const recovered = ethers.verifyMessage(`WaraNode:${name}:${endpoint}`, signature);
                if (recovered.toLowerCase() === info.nodeAddress.toLowerCase()) {
                    return { address: recovered };
                }
            } else if (!name.includes('.wara')) {
                // Fallback for anonymous nodes (signed by address, but no on-chain name)
                const recovered = ethers.verifyMessage(`WaraNode:${name}:${endpoint}`, signature);
                if (recovered.toLowerCase() === name.toLowerCase()) {
                    return { address: recovered };
                }
            }
        } catch (e) {
            // console.warn(`[Gossip] Verification failed for ${name}:`, e);
        }
        return null;
    }

    public async resolveSentinelNode(name: string): Promise<string | null> {
        try {
            const clean = name.replace('.wara', '');
            // Check cache first? No, we want fresh data for "Connect" action.
            const info = await this.registryContract.getNode(clean);
            // [operator, nodeAddress, expiresAt, active, currentIP]
            // Safe access for both array and struct return types
            const ip = info[4] || info.currentIP;
            const isActive = info.active && info.expiresAt > Date.now() / 1000; // Contract usually uses block.timestamp (seconds)

            if (ip && isActive) {
                console.log(`[Sentinel] Resolved ${name} -> ${ip}`);
                return ip;
            }
            return null;
        } catch (e) {
            console.warn(`[Sentinel] Failed to resolve ${name}`);
            return null;
        }
    }

    public startSentinelCron() {
        if (!this.nodeSigner || !this.registryContract) return;

        console.log('[Sentinel] Starting IP Monitoring & Auto-Update Service...');

        const checkIP = async () => {
            try {
                this.sentinelStatus.lastCheck = Date.now();
                let currentIP = this.publicIp;

                // If publicIp is not set via UPnP/Env, fetch it
                if (!currentIP) {
                    const res = await fetch('https://api.ipify.org?format=json');
                    const json: any = await res.json();
                    currentIP = json.ip;
                }

                if (!currentIP) throw new Error("Could not determine public IP");

                // Construct endpoint
                const myEndpoint = `http://${currentIP}:${this.port}`;

                // Check on-chain IP
                if (!this.nodeName) return; // Skip if no name assigned
                const cleanName = this.nodeName.replace('.muggi', '').replace('.wara', '');
                const onChainNode = await this.rpcManager.callWithFailover(async (provider) => {
                    const contract = this.registryContract.connect(provider) as any;
                    return await contract.getNode(cleanName);
                });

                // ABI updated: [operator, nodeAddress, expiresAt, active, currentIP]
                const onChainIP = onChainNode[4] || onChainNode.currentIP;

                // For MVP: If onChainIP is undefined (old contract), we skip
                if (onChainIP && onChainIP !== myEndpoint) {
                    console.log(`[Sentinel] IP Change Detected (OnChain: ${onChainIP} -> Local: ${myEndpoint}). updating...`);

                    const registryWithNode = this.registryContract.connect(this.nodeSigner!) as any;
                    const tx = await registryWithNode.updateIP(myEndpoint);
                    this.sentinelStatus.lastUpdateHash = tx.hash;
                    console.log(`[Sentinel] IP Update TX sent: ${tx.hash}`);
                } else if (!onChainIP) {
                    // First time or contract mismatch
                    console.log(`[Sentinel] Registering initial IP: ${myEndpoint}`);
                    const registryWithNode = this.registryContract.connect(this.nodeSigner!) as any;
                    try {
                        const tx = await registryWithNode.updateIP(myEndpoint);
                        this.sentinelStatus.lastUpdateHash = tx.hash;
                        console.log(`[Sentinel] Initial IP TX sent: ${tx.hash}`);
                    } catch (e) { /* Ignore if contract doesn't support it yet */ }
                }

                this.sentinelStatus.lastSuccess = true;
                delete this.sentinelStatus.error;
            } catch (e: any) {
                console.warn('[Sentinel] Monitoring check failed', e);
                this.sentinelStatus.lastSuccess = false;
                this.sentinelStatus.error = e.message;
            }
        };

        setInterval(checkIP, 4 * 60 * 60 * 1000); // 4 hours
        checkIP(); // Initial check
    }

    public async syncMediaFromChain() {
        if (!this.mediaRegistry || this.isChainSyncing) return;
        this.isChainSyncing = true;

        const syncStatePath = path.join(this.dataDir, 'sync_state.json');

        // Load last synced block
        if (this.lastSyncedBlock === 0) {
            try {
                if (fs.existsSync(syncStatePath)) {
                    const state = JSON.parse(fs.readFileSync(syncStatePath, 'utf8'));
                    this.lastSyncedBlock = state.lastSyncedBlock || 0;
                }
            } catch (e) { }
        }

        const poll = async () => {
            try {
                const currentBlock = await this.rpcManager.callWithFailover(async (provider) => {
                    return await provider.getBlockNumber();
                });
                const fromBlock = this.lastSyncedBlock > 0 ? this.lastSyncedBlock + 1 : 0;

                if (fromBlock > currentBlock) return;

                // Limit range to avoid RPC timeouts (e.g., 5000 blocks)
                const toBlock = Math.min(currentBlock, fromBlock + 5000);

                const filter = this.mediaRegistry.filters.MediaRegistered();
                const events = await this.mediaRegistry.queryFilter(filter, fromBlock, toBlock);

                if (events.length > 0) {
                    console.log(`[ChainSync] Processing ${events.length} registrations between blocks ${fromBlock}-${toBlock}`);
                    for (const event of events) {
                        try {
                            const { id, source, externalId, title } = (event as any).args;

                            const existing = await this.prisma.media.findUnique({
                                where: { waraId: id }
                            });

                            if (existing) continue;

                            console.log(`[ChainSync] New media discovered: ${title} (${id})`);

                            await this.prisma.media.create({
                                data: {
                                    waraId: id,
                                    source: source,
                                    sourceId: externalId,
                                    title: title,
                                    type: 'movie',
                                    status: 'approved',
                                    overview: '',
                                }
                            });

                            getMediaMetadata(this.prisma, externalId, 'movie', 'approved', this).catch(() => { });
                        } catch (e) { }
                    }
                }

                this.lastSyncedBlock = toBlock;
                fs.writeFileSync(syncStatePath, JSON.stringify({ lastSyncedBlock: this.lastSyncedBlock }));

            } catch (e: any) {
                if (!e.message.includes('resource not found')) {
                    console.warn('[ChainSync] Polling iteration failed:', e.message);
                }
            }
        };

        // Initialize polling loop if not already started
        if (!this.chainSyncInterval) {
            this.chainSyncInterval = setInterval(poll, 6 * 60 * 60 * 1000); // Poll every 6 hours
            poll(); // Immediate first run
        }

        this.isChainSyncing = false;
    }

    private async detectRegion() {
        console.log('[WaraNode] Detecting Region...');
        try {
            const res = await fetch('http://ip-api.com/json/?fields=countryCode,query');
            if (res.ok) {
                const data = await res.json();
                this.region = data.countryCode;
                this.publicIp = (data.query || '').trim(); // Explicitly set public IP here!
                console.log(`[WaraNode] Region Detected: ${this.region} (IP: ${this.publicIp})`);
            } else {
                console.log('[WaraNode] Region detection failed (API Error).');
            }
        } catch (e) {
            console.log('[WaraNode] Region detection failed (Network).');
        }
    }
}
