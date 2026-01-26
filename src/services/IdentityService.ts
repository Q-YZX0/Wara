import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { CONFIG, ABIS } from '../config/config';
import { decryptPrivateKey } from '../utils/encryption';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

export class IdentityService {
    public nodeName: string | null = null;
    public nodeSigner?: ethers.Wallet | ethers.HDNodeWallet;
    public publicIp: string | null = null;
    public nodeOwner: string | null = null;
    public region: string = 'UNKNOWN';
    public adminKey: string = '';
    public sentinelStatus: any = { lastCheck: 0, lastSuccess: false };
    public globalMaxStreams: number = 10;

    // Sessions & Active Wallets
    public activeWallets: Map<string, ethers.Wallet | ethers.HDNodeWallet> = new Map();
    public userSessions: Map<string, string> = new Map(); // AuthToken -> Username
    public activeSessions: Map<string, number> = new Map(); // ip_linkId -> expiry

    // NAT / UPnP Client
    private nat: any;

    private prisma?: PrismaClient;
    private provider?: ethers.Provider;

    constructor() {
        // Setup NAT (deferred init)
        try {
            // @ts-ignore
            const NatAPI = require('nat-api');
            this.nat = new NatAPI();
        } catch (e) {
            console.warn("[Identity] nat-api not available");
        }
    }

    public setContext(prisma: PrismaClient, provider: ethers.Provider) {
        this.prisma = prisma;
        this.provider = provider;
    }

    public async init() {
        this.loadIdentity();
        this.loadAdminKey();

        if (!CONFIG.SKIP_UPNP && !CONFIG.LOCAL_ONLY) {
            await this.detectPublicIp();
        }

        if (!CONFIG.SKIP_BENCHMARK) {
            await this.runBenchmark();
        }

        await this.detectRegion();

        if (this.nodeSigner) console.log(`[Identity] Node Address: ${this.nodeSigner.address}`);
        if (this.nodeName) console.log(`[Identity] Identity: ${this.nodeName}`);
        if (this.publicIp) console.log(`[Identity] Public IP: ${this.publicIp}`);
    }

    private loadIdentity() {
        const idPath = path.join(CONFIG.DATA_DIR, 'node_identity.json');
        if (fs.existsSync(idPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(idPath, 'utf8'));
                if (data.nodeKey || data.privateKey) {
                    this.nodeSigner = new ethers.Wallet(data.nodeKey || data.privateKey);
                }
                if (data.name) this.nodeName = data.name;
                if (data.owner) this.nodeOwner = data.owner;
            } catch (e) {
                console.error("[Identity] Failed to load identity file", e);
            }
        } else {
            // Create new random identity
            this.nodeSigner = ethers.Wallet.createRandom();
            if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

            fs.writeFileSync(idPath, JSON.stringify({
                privateKey: this.nodeSigner.privateKey,
                createdAt: new Date().toISOString()
            }, null, 2));
            console.log("[Identity] Application Identity Generated.");
        }
    }

    private loadAdminKey() {
        const keyPath = path.join(CONFIG.DATA_DIR, 'admin_key.txt');
        if (process.env.ADMIN_KEY) {
            this.adminKey = process.env.ADMIN_KEY;
        } else if (fs.existsSync(keyPath)) {
            this.adminKey = fs.readFileSync(keyPath, 'utf-8').trim();
            console.log(`[Identity] Admin Key loaded from file.`);
        } else {
            this.adminKey = crypto.randomBytes(16).toString('hex');
            if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
            fs.writeFileSync(keyPath, this.adminKey);
            console.log(`[Identity] generated NEW Admin Key: ${this.adminKey}`);
        }
    }

    private async detectPublicIp() {
        console.log(`[Identity] Detecting Public IP(UPnP)...`);
        try {
            // 1. Try UPnP
            if (this.nat) {
                const upnpIpPromise = new Promise<string | null>((resolve) => {
                    this.nat.externalIp((err: any, ip: string) => {
                        if (err) resolve(null);
                        else resolve(ip);
                    });
                });

                const upnpIp = await Promise.race([
                    upnpIpPromise,
                    new Promise<null>(r => setTimeout(() => r(null), 3000))
                ]);

                if (upnpIp) {
                    this.publicIp = upnpIp;
                    return;
                }
            }
        } catch (e: any) {
            console.warn(`[Identity] UPnP IP Detection failed: ${e.message}`);
        }

        // 2. Fallback to API (Already handled by detectRegion in legacy, but we'll double check here)
        if (!this.publicIp) {
            try {
                const res = await axios.get('https://api.ipify.org?format=json');
                if (res.data && res.data.ip) this.publicIp = res.data.ip;
            } catch (e) { }
        }
    }

    private async detectRegion() {
        console.log('[Identity] Detecting Region...');
        try {
            const res = await axios.get('http://ip-api.com/json/?fields=countryCode,query');
            if (res.status === 200 && res.data) {
                this.region = res.data.countryCode || 'GLOBAL';
                if (!this.publicIp || this.publicIp === '127.0.0.1') {
                    this.publicIp = (res.data.query || '').trim();
                }
                console.log(`[Identity] Region Detected: ${this.region} (IP: ${this.publicIp})`);
            }
        } catch (e: any) {
            console.warn('[Identity] Region detection failed:', e.message);
        }
    }

    public async mapPort(port: number): Promise<boolean> {
        if (!this.nat || CONFIG.SKIP_UPNP) return false;

        return new Promise((resolve) => {
            this.nat.map(port, (err: any) => {
                if (err) {
                    console.warn(`[Identity] UPnP Port Map failed: ${err.message}`);
                    resolve(false);
                } else {
                    console.log(`[Identity] UPnP Port Map success: ${port}`);
                    resolve(true);
                }
            });
        });
    }

    public async runBenchmark() {
        console.log(`[Identity] Running Network Benchmark (Upload Speed)...`);
        try {
            // @ts-ignore
            const NetworkSpeed = require('network-speed');
            const networkSpeed = new NetworkSpeed();
            const baseUrl = 'http://eu.httpbin.org/stream-bytes/500000';
            const dlSpeed = await networkSpeed.checkDownloadSpeed(baseUrl, 500000);
            const mbps = parseFloat(dlSpeed.mbps);
            const estimatedUpload = mbps * 0.2; // Conservative heuristic
            const capacity = Math.max(1, Math.floor(estimatedUpload / 5)); // 5mbps per slot
            this.globalMaxStreams = capacity;
            console.log(`[Identity] Auto-Configured Capacity: ${this.globalMaxStreams} (Est. ${estimatedUpload.toFixed(2)} Mbps Up)`);
        } catch (e) {
            console.log(`[Identity] Benchmark failed. Using default capacity: ${this.globalMaxStreams}`);
        }
    }

    public getLocalIp(): string {
        try {
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                if (!interfaces[name]) continue;
                for (const iface of interfaces[name]!) {
                    if ('IPv4' !== iface.family || iface.internal) continue;
                    return iface.address;
                }
            }
        } catch (e) { }
        return '127.0.0.1';
    }

    // --- AUTH & WALLET LOGIC (Migrated from node.ts) ---

    public getAuthenticatedSigner(req: any): ethers.Wallet | null {
        const authToken = (req.headers['x-auth-token'] || req.body.authToken) as string;
        if (authToken && this.activeWallets.has(authToken)) {
            return this.activeWallets.get(authToken)! as ethers.Wallet;
        }

        const providedKey = req.headers['x-wara-key'] || req.body.adminKey;
        if (providedKey === this.adminKey && this.nodeSigner) {
            return this.nodeSigner as ethers.Wallet;
        }

        const remote = req.socket.remoteAddress;
        if (remote === '::1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1') {
            return this.nodeSigner as ethers.Wallet;
        }

        return null;
    }

    public async getLocalUserWallet(address: string, password?: string): Promise<any> {
        // ... (as before)
    }

    public startSentinelCron() {
        if (!this.nodeSigner || !this.provider) return;

        console.log('[Sentinel] Starting IP Monitoring & Auto-Update Service...');

        const checkIP = async () => {
            try {
                this.sentinelStatus.lastCheck = Date.now();
                let currentIP = this.publicIp;

                // If publicIp is not set via UPnP/Env, fetch it
                if (!currentIP) {
                    const res = await axios.get('https://api.ipify.org?format=json');
                    currentIP = res.data.ip;
                }

                if (!currentIP) throw new Error("Could not determine public IP");

                // Construct endpoint
                const myEndpoint = `http://${currentIP}:${CONFIG.PORT}`;

                // Check on-chain IP
                if (!this.nodeName) return; // Skip if no name assigned
                const cleanName = this.nodeName.replace('.muggi', '').replace('.wara', '');

                // Assuming we use the default provider for check
                const registryContract = new ethers.Contract(CONFIG.CONTRACTS.NODE_REGISTRY, ABIS.NODE_REGISTRY, this.provider);
                const onChainNode = await registryContract.getNode(cleanName);

                // ABI updated: [operator, nodeAddress, expiresAt, active, currentIP]
                const onChainIP = onChainNode[4] || onChainNode.currentIP;

                // For MVP: If onChainIP is undefined (old contract), we skip
                if (onChainIP && onChainIP !== myEndpoint) {
                    console.log(`[Sentinel] IP Change Detected (OnChain: ${onChainIP} -> Local: ${myEndpoint}). updating...`);

                    const registryWithNode = registryContract.connect(this.nodeSigner!) as any;
                    const tx = await registryWithNode.updateIP(myEndpoint);
                    this.sentinelStatus.lastUpdateHash = tx.hash;
                    console.log(`[Sentinel] IP Update TX sent: ${tx.hash}`);
                } else if (!onChainIP) {
                    // First time or contract mismatch
                    console.log(`[Sentinel] Registering initial IP: ${myEndpoint}`);
                    const registryWithNode = registryContract.connect(this.nodeSigner!) as any;
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

    public requireAuth = (req: any, res: any, next: any) => {
        const remote = req.socket.remoteAddress;
        const providedKey = req.headers['x-wara-key'];

        if (providedKey === this.adminKey) {
            return next();
        }

        const isLocal = remote === '::1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1';

        if (isLocal) {
            const authToken = (req.headers['x-auth-token'] || req.headers['x-wara-token'] || req.body.authToken) as string;
            if (authToken && (this.activeWallets.has(authToken) || this.userSessions.has(authToken))) {
                return next();
            }

            if (req.path === '/api/admin/status' || req.originalUrl.includes('/admin/status')) {
                return next();
            }

            console.warn(`[Identity] Localhost admin attempt blocked. No active session.`);
            return res.status(401).json({ error: 'Local Admin requires Login' });
        }

        console.warn(`[Identity] Blocked unauthorized admin attempt from ${remote}`);
        res.status(403).json({ error: 'Access denied. Valid Admin Key required.' });
    }
}
