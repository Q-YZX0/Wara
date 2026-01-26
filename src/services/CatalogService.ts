import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CONFIG } from '../config/config';
import { P2PService } from './P2PService';
import { WaraMap } from '../types';

export interface RegisteredLink {
    id: string;
    filePath: string;
    map: WaraMap;
    activeStreams: number;
    maxStreams: number;
    key?: string;
}

export class CatalogService {
    // In-memory storage of Local Content
    public links: Map<string, RegisteredLink> = new Map();
    public globalMaxStreams: number = 50;
    private minFreeRamMB = 500;
    private gcInterval: NodeJS.Timeout | null = null;

    constructor(private p2pService: P2PService) { }

    public init() {
        console.log(`[Catalog] Initializing Content Catalog...`);
        this.loadExistingLinks();
        this.startGarbageCollector();
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

    public getLink(id: string): RegisteredLink | undefined {
        return this.links.get(id);
    }

    public registerLink(id: string, encryptedFilePath: string, map: WaraMap, key?: string) {
        if (!fs.existsSync(encryptedFilePath)) {
            console.warn(`[Catalog] File not found: ${encryptedFilePath}`);
            return;
        }

        this.links.set(id, {
            id,
            filePath: encryptedFilePath,
            map,
            activeStreams: 0,
            maxStreams: this.globalMaxStreams,
            key: key
        });
        console.log(`[Catalog] Registered: ${map.title} (${id})`);
    }

    private loadExistingLinks() {
        const linksDir = path.join(CONFIG.DATA_DIR, 'links');
        const adsDir = path.join(CONFIG.DATA_DIR, 'ads');

        if (!fs.existsSync(linksDir)) fs.mkdirSync(linksDir, { recursive: true });
        if (!fs.existsSync(adsDir)) fs.mkdirSync(adsDir, { recursive: true });

        // Scan Standard Content
        this.scanDir(linksDir);
        // Scan Ads
        this.scanDir(adsDir, true);
    }

    private scanDir(dir: string, isAd: boolean = false) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                this.scanDir(fullPath, isAd);
            } else if (file.endsWith('.wara')) {
                // Found encrypted content
                try {
                    const mapPath = fullPath.replace('.wara', '.json');
                    const keyPath = fullPath.replace('.wara', '.key');

                    if (fs.existsSync(mapPath)) {
                        const map: WaraMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));

                        let key: string | undefined = undefined;
                        if (fs.existsSync(keyPath)) {
                            key = fs.readFileSync(keyPath, 'utf-8').trim();
                        }

                        // Override storage path in map just in case
                        // map.storagePath = fullPath; // (WaraMap check types)

                        this.registerLink(map.id, fullPath, map, key);
                    }
                } catch (e) {
                    console.error(`[Catalog] Failed to load ${file}`, e);
                }
            }
        }
    }

    /**
     * Merges Local + Remote Catalog for Discovery
     * This logic was previously in node.getResolvedCatalog
     */
    public async getResolvedCatalog(prismaContent: any[]) {
        // 1. Local Links
        const localItems = Array.from(this.links.values()).map(l => ({
            id: l.id,
            title: l.map.title,
            activeStreams: l.activeStreams,
            mediaInfo: l.map.mediaInfo,
            hosterAddress: l.map.hosterAddress,
            // URL will be constructed by the Controller/Route, not here strictly, 
            // but we provide the raw data needed.
            // For compatibility with frontend P2P display:
            url: `http://localhost:${CONFIG.PORT}/wara/${l.id}${l.key ? '#' + l.key : ''}`,
            isLocal: true
        }));

        // 2. P2P Links (from DB passed as argument or fetched here)
        // Resolving remote URLs happens here
        const p2pItems = await Promise.all(prismaContent.map(async (link) => {
            // 1. Resolve Local URL
            if (link.isLocal) {
                const ip = this.p2pService.identityService.publicIp || 'localhost';
                return {
                    ...link,
                    url: `http://${ip}:${CONFIG.PORT}/api/stream/${link.id}${link.key ? '#' + link.key : ''}`
                };
            }

            // 2. Resolve Remote URL
            let finalUrl = link.url;
            try {
                const urlObj = new URL(link.url);
                const hostname = urlObj.hostname;
                const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname === 'localhost';

                if (!isIp) {
                    let resolvedEndpoint: string | null = null;

                    // A. Check Memory Cache
                    if (this.p2pService.knownPeers.has(hostname)) {
                        resolvedEndpoint = this.p2pService.knownPeers.get(hostname)?.endpoint || null;
                    }

                    // B. Query Blockchain Registry (Sentinel)
                    if (!resolvedEndpoint) {
                        resolvedEndpoint = await this.p2pService.resolveSentinelNode(hostname);
                    }

                    if (resolvedEndpoint) {
                        finalUrl = link.url.replace(`http://${hostname}`, resolvedEndpoint);
                    }
                }
            } catch (e) { }

            return {
                id: link.id,
                title: link.title,
                activeStreams: 0,
                mediaInfo: link.waraMetadata ? (JSON.parse(link.waraMetadata as string)) : {},
                hosterAddress: link.uploaderWallet,
                url: finalUrl,
                isLocal: false
            };
        }));

        // Merge, preferring Local
        const seen = new Set(localItems.map(i => i.id));
        const uniqueP2P = p2pItems.filter(i => !seen.has(i.id));

        return [...localItems, ...uniqueP2P];
    }

    private startGarbageCollector() {
        const tempDir = path.join(CONFIG.DATA_DIR, 'temp');
        if (!fs.existsSync(tempDir)) return;

        this.gcInterval = setInterval(() => {
            console.log(`[Catalog] [GC] Checking for stale temp uploads...`);
            try {
                const files = fs.readdirSync(tempDir);
                const now = Date.now();
                const threshold = 24 * 60 * 60 * 1000; // 24 hours

                files.forEach(file => {
                    const filePath = path.join(tempDir, file);
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtimeMs > threshold) {
                        console.log(`[Catalog] [GC] Removing stale upload: ${file}`);
                        fs.unlinkSync(filePath);
                    }
                });
            } catch (e) {
                console.error("[Catalog] [GC] Error:", e);
            }
        }, 60 * 60 * 1000); // Check every hour
    }

    public stop() {
        if (this.gcInterval) clearInterval(this.gcInterval);
    }
}
