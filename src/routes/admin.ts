import { Router, Request, Response } from 'express';
import { App } from '../App';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../config/config';
import { createWaraLink } from '../utils/LinkCreator';
import { WaraMap } from '../types';
import { ethers } from 'ethers';

export const setupAdminRoutes = (node: App) => {
    const router = Router();

    // POST /admin/publish
    router.post('/publish', node.identity.requireAuth, async (req: Request, res: Response) => {
        try {
            const { filePath, title, mediaInfo } = req.body;
            if (!filePath || !title) return res.status(400).json({ error: 'Missing filePath or title' });
            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Source file not found' });

            console.log(`[App] Admin requested publish: ${title}`);
            const result = await createWaraLink(filePath, title, CONFIG.DATA_DIR, mediaInfo);
            node.catalog.registerLink(result.map.id, result.encryptedPath, result.map, result.key);

            const effectiveHost = node.identity.publicIp ? node.identity.publicIp : 'localhost';
            const endpointWithKey = `http://${effectiveHost}:${CONFIG.PORT}/stream/${result.map.id}#${result.key}`;

            res.json({
                success: true,
                linkId: result.map.id,
                key: result.key,
                map: { ...result.map, publicEndpoint: endpointWithKey }
            });

        } catch (e: any) {
            console.error(e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /admin/import
    router.post('/import', node.identity.requireAuth, async (req: Request, res: Response) => {
        console.log(`[App] INCOMING IMPORT REQUEST`);
        const filename = req.headers['x-filename'] as string || `upload_${Date.now()}.mp4`;
        const title = req.headers['x-title'] as string || filename;
        const hosterAddress = req.headers['x-hoster'] as string;
        const mediaInfoStr = req.headers['x-mediainfo'] as string || '{}';

        console.log(`[App] Headers: Title=${title}, Filename=${filename}, Hoster=${hosterAddress}`);
        const tempBase = path.join(CONFIG.DATA_DIR, 'temp');
        if (!fs.existsSync(tempBase)) fs.mkdirSync(tempBase, { recursive: true });

        const tempPath = path.join(tempBase, filename);

        const writeStream = fs.createWriteStream(tempPath);
        req.pipe(writeStream);

        writeStream.on('finish', async () => {
            try {
                console.log(`[WaraNode] File received. Encrypting...`);
                const mediaInfo = JSON.parse(mediaInfoStr);
                // Standardize mediaInfo if needed
                if (mediaInfo.tmdbId && !mediaInfo.sourceId) {
                    mediaInfo.sourceId = String(mediaInfo.tmdbId);
                    mediaInfo.source = mediaInfo.source || 'tmdb';
                }

                const result = await createWaraLink(tempPath, title, tempBase, mediaInfo, hosterAddress);
                const nodeIdentifier = node.identity.nodeName || node.blockchain.wallet?.address || 'unknown';
                const portableUrl = `http://${nodeIdentifier}/stream/${result.map.id}#${result.key}`;

                res.json({
                    success: true,
                    linkId: result.map.id,
                    key: result.key,
                    map: { ...result.map, publicEndpoint: portableUrl }
                });
            } catch (e) {
                console.error("Encryption failed after upload", e);
                res.status(500).json({ error: "Processing failed" });
            }
        });

        writeStream.on('error', (err) => {
            console.error("Upload stream error", err);
            res.status(500).json({ error: "Upload failed" });
        });
    });

    // --- Admin: Upload Subtitle ---
    router.post('/subtitle', node.identity.requireAuth, (req: Request, res: Response) => {
        const linkId = req.headers['x-link-id'] as string;
        const lang = req.headers['x-lang'] as string;
        const label = req.headers['x-label'] as string;
        const filename = req.headers['x-filename'] as string;

        if (!linkId || !lang || !node.catalog.links.has(linkId)) {
            return res.status(404).json({ error: 'Link not found' });
        }

        const link = node.catalog.links.get(linkId)!;
        // Determine extension. Prefer vtt.
        let ext = 'vtt';
        if (filename && filename.endsWith('.srt')) ext = 'srt';

        const subFileName = `${linkId}_${lang}.${ext}`;
        const subFilePath = path.join(CONFIG.DATA_DIR, subFileName);

        const writeStream = fs.createWriteStream(subFilePath);
        req.pipe(writeStream);

        writeStream.on('finish', () => {
            // Cleanup conflicting extensions (priority issue)
            const otherExt = ext === 'vtt' ? 'srt' : 'vtt';
            const otherFile = path.join(CONFIG.DATA_DIR, `${linkId}_${lang}.${otherExt}`);
            try { if (fs.existsSync(otherFile)) fs.unlinkSync(otherFile); } catch (e) { }

            // Update Link Map
            if (!link.map.subtitles) link.map.subtitles = [];
            // Remove existing if any (Case Insensitive + Trim)
            const targetLang = lang.trim().toLowerCase();
            link.map.subtitles = link.map.subtitles.filter(s => (s.lang || '').trim().toLowerCase() !== targetLang);

            link.map.subtitles.push({
                id: `${linkId}_${lang}`,
                lang,
                label: label || lang.toUpperCase()
            });

            // Persist new map to JSON
            try {
                const mapPath = path.join(CONFIG.DATA_DIR, `${linkId}.json`);
                fs.writeFileSync(mapPath, JSON.stringify(link.map, null, 2));
                console.log(`[App] Subtitle added: ${lang} for ${linkId}`);
                res.json({ success: true });
            } catch (e) {
                console.error("Failed to update map json", e);
                res.status(500).json({ error: "Map update failed" });
            }
        });

        writeStream.on('error', (err) => {
            console.error("Subtitle upload failed", err);
            res.status(500).json({ error: "Write failed" });
        });
    });

    // POST /admin/peer
    router.post('/peer', node.identity.requireAuth, (req: Request, res: Response) => {
        const { name, endpoint } = req.body;
        if (!name || !endpoint) return res.status(400).json({ error: 'Name and endpoint are required' });

        node.p2p.knownPeers.set(name, { name, endpoint, lastSeen: Date.now() });
        console.log(`[Admin] Manually added peer: ${name} (${endpoint})`);
        res.json({ success: true, message: `Peer "${name}" added successfully`, totalPeers: node.p2p.knownPeers.size });
    });

    // GET /admin/status
    router.get('/status', node.requireAuth, async (req: Request, res: Response) => {

        // Force reload identity from disk to ensure consistency
        try {
            const idPath = path.join(CONFIG.DATA_DIR, 'node_identity.json');
            if (fs.existsSync(idPath)) {
                const identity = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
                if (identity.name) node.identity.nodeName = identity.name;
                if (identity.owner) node.identity.nodeOwner = identity.owner;
            }
        } catch (e) { }

        let diskSpace = null;
        try {
            const fsAny = fs as any;
            if (fsAny.statfsSync) {
                const stats = fsAny.statfsSync(CONFIG.DATA_DIR);
                diskSpace = {
                    free: Number(stats.bfree) * Number(stats.bsize),
                    total: Number(stats.blocks) * Number(stats.bsize),
                    used: (Number(stats.blocks) - Number(stats.bfree)) * Number(stats.bsize)
                };
            }
        } catch (e) {
            console.error("Disk stat failed:", e);
        }

        let systemInfo: any = {};
        try {
            const os = require('os');
            systemInfo = {
                freeMem: os.freemem(),
                totalMem: os.totalmem(),
                loadAvg: os.loadavg(),
                cpus: os.cpus().length,
                disk: diskSpace
            };
        } catch (e) {
            console.error("Disk stat failed:", e);
        }

        let nodeBalance = '0';
        if (node.blockchain.wallet) {
            try {
                const bal = await node.blockchain.provider.getBalance(node.blockchain.wallet.address);
                nodeBalance = ethers.formatEther(bal);
            } catch (e) { }
        }

        res.json({
            nodeId: node.identity.nodeSigner?.address || 'unknown',
            nodeName: node.identity.nodeName,
            nodeOwner: node.identity.nodeOwner,
            nodeAddress: node.blockchain.wallet?.address,
            nodeBalance: nodeBalance,
            sentinel: node.identity.sentinelStatus,
            config: { port: CONFIG.PORT, dataDir: CONFIG.DATA_DIR, trackers: node.p2p.trackers },
            resources: systemInfo,
            network: { publicIp: node.identity.publicIp, capacity: node.catalog.globalMaxStreams, region: node.identity.region },
            peers: node.p2p.knownPeers.size
        });
    });

    // GET /admin/health - Simple health check for monitoring
    router.get('/health', (req: Request, res: Response) => {
        const health = {
            status: 'ok',
            uptime: process.uptime(),
            timestamp: Date.now(),
            services: {
                blockchain: node.blockchain.provider ? 'connected' : 'disconnected',
                database: 'connected', // Prisma auto-connects
                peers: node.p2p.knownPeers.size
            }
        };
        res.json(health);
    });

    // GET /admin/catalog (Separated for performance)
    router.get('/catalog', node.identity.requireAuth, async (req: Request, res: Response) => {
        const prismaContent = await node.prisma.link.findMany();
        const content = await node.catalog.getResolvedCatalog(prismaContent);
        res.json({ success: true, content });
    });

    // POST /admin/identity
    router.post('/identity', node.identity.requireAuth, (req: Request, res: Response) => {
        const { name, nodeKey } = req.body;
        const idPath = path.join(CONFIG.DATA_DIR, 'node_identity.json');
        if (fs.existsSync(idPath)) return res.status(403).json({ error: 'Node identity is locked.' });
        if (!name || !nodeKey) return res.status(400).json({ error: 'Name and nodeKey are required' });

        const identity = { name, nodeKey, createdAt: new Date().toISOString() };
        const finalName = name.includes('.wara') ? name : `${name}.wara`;

        node.identity.nodeName = finalName;
        try { node.identity.nodeSigner = new ethers.Wallet(nodeKey); } catch (e) { }

        fs.writeFileSync(idPath, JSON.stringify(identity, null, 2));
        console.log(`[App] Identity LOCKED: ${finalName}`);
        res.json({ success: true, message: 'Identity locked successfully' });
    });

    // GET /admin/identity
    router.get('/identity', node.identity.requireAuth, (req: Request, res: Response) => {
        const idPath = path.join(CONFIG.DATA_DIR, 'node_identity.json');
        if (fs.existsSync(idPath)) {
            const identity = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
            res.json({ locked: true, name: identity.name, createdAt: identity.createdAt });
        } else {
            res.json({ locked: false });
        }
    });

    // POST /admin/sync
    router.post('/sync', node.identity.requireAuth, async (req: Request, res: Response) => {
        node.p2p.syncNetwork();
        res.json({ success: true, message: 'Sync started' });
    });

    // POST /admin/trackers (Bulk Replace)
    router.post('/trackers', node.identity.requireAuth, (req: Request, res: Response) => {
        const { trackers } = req.body;
        if (!Array.isArray(trackers)) return res.status(400).json({ error: 'trackers must be an array' });

        node.p2p.trackers = trackers.filter((t: any) => typeof t === 'string' && t.length > 0);
        console.log(`[App] Trackers updated: ${node.p2p.getTrackers().join(', ')}`);

        node.p2p.saveTrackers();
        node.p2p.startHeartbeat();

        res.json({ success: true, trackers: node.p2p.getTrackers() });
    });

    // GET /admin/trackers (List)
    router.get('/trackers', node.identity.requireAuth, (req: Request, res: Response) => {
        res.json({ trackers: node.p2p.getTrackers() });
    });

    // PUT /admin/trackers (Add One)
    router.put('/trackers', node.identity.requireAuth, (req: Request, res: Response) => {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'Missing tracker URL' });
        node.p2p.addTracker(url);
        res.json({ success: true, trackers: node.p2p.getTrackers() });
    });

    // DELETE /admin/trackers (Remove One)
    router.delete('/trackers', node.identity.requireAuth, (req: Request, res: Response) => {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'Missing tracker URL' });
        node.p2p.removeTracker(url);
        res.json({ success: true, trackers: node.p2p.getTrackers() });
    });

    // --- NEW: Mirror Endpoint (Replication) ---
    router.post('/mirror', node.identity.requireAuth, async (req: Request, res: Response) => {
        try {
            const { outputUrl } = req.body;
            if (!outputUrl) return res.status(400).json({ error: "Missing outputUrl" });

            console.log(`[App] Mirroring content from ${outputUrl}...`);

            const mapRes = await fetch(`${outputUrl}/map`);
            if (!mapRes.ok) throw new Error("Could not fetch remote map");
            const map = await mapRes.json() as WaraMap;

            const streamUrl = `${outputUrl}/stream`;
            const response = await fetch(streamUrl);
            if (!response.ok || !response.body) throw new Error("Could not fetch remote stream");

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const localPath = path.join(CONFIG.DATA_DIR, `${map.id}.wara`);
            fs.writeFileSync(localPath, buffer);
            fs.writeFileSync(path.join(CONFIG.DATA_DIR, `${map.id}.json`), JSON.stringify(map, null, 2));

            node.catalog.registerLink(map.id, localPath, map);

            const effectiveHost = node.identity.publicIp ? node.identity.publicIp : 'localhost';
            res.json({
                success: true,
                linkId: map.id,
                mirroredFrom: outputUrl,
                map: { ...map, publicEndpoint: `http://${effectiveHost}:${CONFIG.PORT}/stream/${map.id}` }
            });

        } catch (e: any) {
            console.error(e);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Admin: Cache Image (For P2P Metadata) ---
    router.post('/cache-image', node.identity.requireAuth, (req: Request, res: Response) => {
        const imagePath = req.headers['x-image-path'] as string;
        if (!imagePath || imagePath.includes('..')) return res.status(400).json({ error: 'Invalid image path' });

        const fullPath = path.join(CONFIG.DATA_DIR, imagePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const writeStream = fs.createWriteStream(fullPath);
        req.pipe(writeStream);

        writeStream.on('finish', () => {
            console.log(`[App] Cached image: ${imagePath}`);
            res.json({ success: true, path: imagePath });
        });

        writeStream.on('error', (err) => {
            console.error("Image cache failed", err);
            res.status(500).json({ error: "Write failed" });
        });
    });

    //--Proof admin

    router.get('/proofs', node.identity.requireAuth, async (req: Request, res: Response) => {
        try {
            const { hoster } = req.query;
            const signer = node.identity.getAuthenticatedSigner(req);
            if (!signer) return res.status(401).json({ error: 'Authentication required' });

            const targetWallet = ((hoster as string) || (signer as any).address).toLowerCase();
            const proofsDir = path.join(CONFIG.DATA_DIR, 'proofs');
            if (!fs.existsSync(proofsDir)) return res.json([]);

            const files = fs.readdirSync(proofsDir).filter(f => f.endsWith('.json'));
            const proofs = files.map(f => {
                const data = JSON.parse(fs.readFileSync(path.join(proofsDir, f), 'utf8'));
                return { ...data, _filename: f };
            });

            const filtered = proofs.filter(p => (p.uploaderWallet || '').toLowerCase() === targetWallet);
            res.json(filtered);
        } catch (e) {
            console.error("Proof audit error", e);
            res.status(500).json({ error: 'Could not read proofs' });
        }
    });

    // --- Batch Delete Proofs (After on-chain claim) ---
    router.post('/proofs/delete', node.identity.requireAuth, (req: Request, res: Response) => {
        const { filenames } = req.body;
        if (!Array.isArray(filenames)) return res.status(400).json({ error: 'Filenames array required' });

        const proofsDir = path.join(CONFIG.DATA_DIR, 'proofs');
        let deleted = 0;

        filenames.forEach(f => {
            if (!/^[a-z0-9_.-]+$/i.test(f)) return; // Security
            const p = path.join(proofsDir, f);
            try {
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                    deleted++;
                }
            } catch (e) { }
        });

        console.log(`[App] Deleted ${deleted} claimed proofs.`);
        res.json({ success: true, deleted });
    });

    // --- Batch Delete Votes (After on-chain sync) ---
    router.post('/votes/delete', node.identity.requireAuth, (req: Request, res: Response) => {
        const { filenames } = req.body;
        if (!Array.isArray(filenames)) return res.status(400).json({ error: 'Filenames array required' });

        const votesDir = path.join(CONFIG.DATA_DIR, 'votes');
        let deleted = 0;

        filenames.forEach(f => {
            if (!/^[a-z0-9_.-]+$/i.test(f)) return; // Security
            const p = path.join(votesDir, f);
            try {
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                    deleted++;
                }
            } catch (e) { }
        });

        console.log(`[App] Deleted ${deleted} synced votes.`);
        res.json({ success: true, deleted });
    });

    // --- Delete Link from node
    router.delete('/link/delete/:id', node.identity.requireAuth, async (req: Request, res: Response) => {
        const { id } = req.params;
        const link = node.catalog.links.get(id);

        if (!link) {
            return res.status(404).json({ error: "Link not found" });
        }

        try {
            // 1. Remove from Memory
            node.catalog.links.delete(id);

            // 2. Remove Files
            const waraPath = link.filePath;
            const jsonPath = waraPath.replace('.wara', '.json');

            if (fs.existsSync(waraPath)) fs.unlinkSync(waraPath);
            if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

            // 3. Cleanup Subtitles (Best effort)
            const dir = path.dirname(waraPath);
            const files = fs.readdirSync(dir);
            for (const f of files) {
                if (f.startsWith(`${id}_`)) { // id_subId.vtt
                    try { fs.unlinkSync(path.join(dir, f)); } catch (e) { }
                }
            }

            console.log(`[App] Deleted link: ${id}`);
            res.json({ success: true });

        } catch (e) {
            console.error("Delete failed", e);
            res.status(500).json({ error: "Failed to delete files" });
        }
    });

    return router;
};
