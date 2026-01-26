import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { CONFIG } from './config/config';
import { IdentityService } from './services/IdentityService';
import { BlockchainService } from './services/BlockchainService';
import { P2PService } from './services/P2PService';
import { CatalogService } from './services/CatalogService';
import { StreamService } from './services/StreamService';
import { AdService } from './services/AdService';
import { OracleService } from './services/OracleService';

// Route imports (to be refactored)
import { MediaService } from './services/MediaService';
import { setupAuthRoutes } from './routes/auth';
import { setupAdminRoutes } from './routes/admin';
import { setupNetworkRoutes } from './routes/network';
import { setupCatalogRoutes } from './routes/catalog';
import { setupLinkRoutes } from './routes/link';
import { setupStreamRoutes } from './routes/stream';
import { setupRegistryRoutes } from './routes/registry';
import { setupRemoteRoutes } from './routes/remote';
import { setupLeaderboardRoutes } from './routes/leaderboard';
import { setupOracleRoutes } from './routes/oracle';
import { setupWalletRoutes } from './routes/wallet';
import { setupMediaRoutes } from './routes/media';
import { setupSubscriptionRoutes } from './routes/subscription';
import { setupAirdropRoutes } from './routes/airdrop';
import { setupDaoRoutes } from './routes/dao';
import { ethers } from 'ethers';

export class App {
    public app: express.Application;
    public prisma: PrismaClient;

    // Services
    public identity: IdentityService;
    public blockchain: BlockchainService;
    public p2p: P2PService;
    public catalog: CatalogService;
    public stream: StreamService;
    public ads: AdService;
    public oracle: OracleService;
    public media: MediaService;

    // --- LEGACY BRIDGE (Compatibility for WaraNode interface) ---
    get nodeId() { return this.identity.nodeSigner?.address || 'unknown'; }
    get nodeName() { return this.identity.nodeName; }
    get publicIp() { return this.identity.publicIp; }
    get region() { return this.identity.region; }
    get adminKey() { return this.identity.adminKey; }
    get port() { return Number(CONFIG.PORT); }
    get dataDir() { return CONFIG.DATA_DIR; }
    get provider() { return this.blockchain.provider; }
    get nodeSigner() { return this.identity.nodeSigner; }

    // Sessions & Wallets
    get activeWallets() { return this.identity.activeWallets; }
    get userSessions() { return this.identity.userSessions; }
    get activeSessions() { return this.identity.activeSessions; }

    // Contracts
    get adManager() { return (this.blockchain as any).ads; }
    get subContract() { return (this.blockchain as any).subscriptions; }
    get mediaRegistry() { return (this.blockchain as any).registry; }

    // Catalog & Peer Data
    get links() { return (this.catalog as any).links; }
    get knownPeers() { return (this.p2p as any).knownPeers; }

    // Middleware
    public requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const authHeader = req.headers['authorization'] || req.headers['x-admin-key'];
        if (authHeader === this.adminKey) {
            return next();
        }
        res.status(401).json({ error: 'Admin authentication required' });
    };

    // Proxy Methods
    public registerLink(id: string, path: string, map: any, key?: string) {
        return this.catalog.registerLink(id, path, map, key);
    }

    public isSystemOverloaded() {
        return false; // MVP fallback
    }

    public get globalMaxStreams() { return 10; }

    public getAuthenticatedSigner(req: express.Request) {
        // Simple logic from old node
        const authToken = (req.headers['x-auth-token'] || req.body.authToken) as string;
        if (authToken && this.activeWallets.has(authToken)) {
            return this.activeWallets.get(authToken);
        }
        if (req.headers['x-admin-key'] === this.adminKey) {
            return this.nodeSigner;
        }
        return null;
    }

    public async getResolvedCatalog() {
        const prismaContent = await this.prisma.link.findMany({
            orderBy: { createdAt: 'desc' }
        });
        return this.catalog.getResolvedCatalog(prismaContent);
    }

    public getTrackers() { return (this.p2p as any).trackers || []; }
    public addTracker(url: string) { return (this.p2p as any).addTracker?.(url); }
    public removeTracker(url: string) { return (this.p2p as any).removeTracker?.(url); }
    public savePeers() { return (this.p2p as any).savePeers?.(); }
    public async verifyPeerIdentity(name: string, endpoint: string, sig: any) {
        return (this.p2p as any).verifyPeerIdentity?.(name, endpoint, sig);
    }
    public async resolveSentinelNode(name: string) {
        return (this.p2p as any).resolveSentinelNode?.(name);
    }

    // Discovery Methods (for admin.ts)
    get heartbeatInterval() { return this.p2p.heartbeatInterval; }
    set heartbeatInterval(val: any) { this.p2p.heartbeatInterval = val; }
    get gossipInterval() { return this.p2p.gossipInterval; }
    set gossipInterval(val: any) { this.p2p.gossipInterval = val; }

    public startHeartbeat() { return this.p2p.startHeartbeat(); }
    public startGossip() { return (this.p2p as any).startGossip?.(); }

    constructor() {
        this.app = express();
        this.prisma = new PrismaClient();

        // 1. Instantiate Services (Order of dependency)
        this.identity = new IdentityService();
        this.blockchain = new BlockchainService(this.identity);
        this.p2p = new P2PService(this.identity, this.blockchain);
        this.catalog = new CatalogService(this.p2p);
        this.stream = new StreamService(this.catalog, this.blockchain, this.identity);
        this.ads = new AdService(this.blockchain, this.identity, this.p2p, this.catalog);
        this.oracle = new OracleService(this.identity, this.blockchain);
        this.media = new MediaService(this.blockchain, this.identity);
    }

    public async init() {
        console.log("-----------------------------------------");
        console.log("   WARA NODE - MODULAR ARCHITECTURE      ");
        console.log("-----------------------------------------");

        // 2. Initialize Contexts (Service Cross-Linking)
        this.identity.setContext(this.prisma, this.blockchain.provider);
        this.p2p.setContext(this.prisma);

        // 3. Initialize Services
        await this.identity.init();
        await this.blockchain.init();
        await this.p2p.init();
        await this.catalog.init();
        this.ads.init();
        this.media.init(this.prisma);
        await this.oracle.start();

        // 3. Setup Express
        this.setupExpress();
        this.setupRoutes();

        // 4. Start Server
        const port = Number(CONFIG.PORT);
        this.app.listen(port, '0.0.0.0', () => {
            console.log(`[App] Server running on port ${port}`);
        });
    }

    private setupExpress() {
        const rateLimit = require('express-rate-limit');

        this.app.use(cors());
        this.app.use(express.json());

        // Rate limiting for API routes
        const apiLimiter = rateLimit({
            windowMs: 15 * 60 * 1000, // 15 minutes
            max: 100, // 100 requests per IP
            message: 'Too many requests from this IP, please try again later.',
            standardHeaders: true,
            legacyHeaders: false,
        });

        // Stricter rate limiting for streaming
        const streamLimiter = rateLimit({
            windowMs: 1 * 60 * 1000, // 1 minute
            max: 30, // 30 requests per IP
            message: 'Too many stream requests, please slow down.',
        });

        this.app.use('/api/', apiLimiter);
        this.app.use('/stream/', streamLimiter);

        // Security Middleware: LOCAL_ONLY Mode
        if (CONFIG.LOCAL_ONLY) {
            this.app.use((req, res, next) => {
                const ip = req.ip || req.socket.remoteAddress || '';
                const isLocal = ip === '::1' || ip.includes('127.0.0.1') || ip === 'localhost';

                // Block sensitive paths from external IPs
                // Allow: /api/catalog, /stream/ (public streaming)
                const sensitivePaths = ['/api/auth/', '/api/wallet/', '/admin/', '/api/remote-nodes'];
                const isSensitive = sensitivePaths.some(p => req.path.startsWith(p));

                if (isSensitive && !isLocal) {
                    console.warn(`[SECURITY] Blocked external access to ${req.path} from ${ip}`);
                    return res.status(403).json({ error: 'Remote administration Disabled (LOCAL_ONLY)' });
                }
                next();
            });
        }

        // Log all requests for debugging (except status checks)
        this.app.use((req, res, next) => {
            if (!req.url.startsWith('/admin/status')) {
                console.log(`[HTTP] ${req.method} ${req.url}`);
            }
            next();
        });
    }

    public stop() {
        this.p2p.stop();
        this.ads.stop();
        this.oracle.stop();
        this.catalog.stop();
    }

    private setupRoutes() {
        // Passing 'this' as the node instance to maintain compatibility with restored routes
        this.app.use('/api/auth', setupAuthRoutes(this as any));
        this.app.use('/api/admin', setupAdminRoutes(this as any));
        this.app.use('/api/network', setupNetworkRoutes(this as any));
        this.app.use('/api/catalog', setupCatalogRoutes(this as any));
        this.app.use('/api/links', setupLinkRoutes(this as any));
        this.app.use('/api/stream', setupStreamRoutes(this as any));
        this.app.use('/api/registry', setupRegistryRoutes(this as any));
        this.app.use('/api/remote', setupRemoteRoutes(this as any));
        this.app.use('/api/leaderboard', setupLeaderboardRoutes(this as any));
        this.app.use('/api/oracle', setupOracleRoutes(this as any));
        this.app.use('/api/wallet', setupWalletRoutes(this as any));
        this.app.use('/api/media', setupMediaRoutes(this as any));
        this.app.use('/api/subscription', setupSubscriptionRoutes(this as any));
        this.app.use('/api/airdrop', setupAirdropRoutes(this as any));
        this.app.use('/api/dao', setupDaoRoutes(this as any));
    }
}
