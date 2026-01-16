import { Express, Request, Response } from 'express';
import { WaraNode } from '../node';
import * as fs from 'fs';
import * as path from 'path';
import { createWaraLink } from '../index';
import { WaraMap } from '../types';

export const setupAdminRoutes = (app: Express, node: WaraNode) => {

    // POST /admin/publish
    app.post('/admin/publish', node.requireAuth, async (req: Request, res: Response) => {
        try {
            const { filePath, title, mediaInfo } = req.body;
            if (!filePath || !title) return res.status(400).json({ error: 'Missing filePath or title' });
            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Source file not found' });

            console.log(`[WaraNode] Admin requested publish: ${title}`);
            const result = await createWaraLink(filePath, title, node.dataDir, mediaInfo);
            node.registerLink(result.map.id, result.encryptedPath, result.map, result.key);

            const effectiveHost = (node as any).publicIp ? (node as any).publicIp : 'localhost';
            const endpointWithKey = `http://${effectiveHost}:${node.port}/wara/${result.map.id}#${result.key}`;

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
    app.post('/admin/import', node.requireAuth, async (req: Request, res: Response) => {
        console.log(`[WaraNode] INCOMING IMPORT REQUEST`);
        const filename = req.headers['x-filename'] as string || `upload_${Date.now()}.mp4`;
        const title = req.headers['x-title'] as string || filename;
        const hosterAddress = req.headers['x-hoster'] as string;
        const mediaInfoStr = req.headers['x-mediainfo'] as string || '{}';

        console.log(`[WaraNode] Headers: Title=${title}, Filename=${filename}, Hoster=${hosterAddress}`);
        const tempBase = path.join(node.dataDir, 'temp');
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
                // SKIP node.registerLink(result.map.id, result.encryptedPath, result.map, result.key);
                // Content stays in temp/ until sealed via /api/links

                // Priority: nodeName (if registered) > nodeAddress (technical wallet)
                const nodeAny = node as any;
                const nodeIdentifier = nodeAny.nodeName || nodeAny.nodeAddress || 'unknown';
                const portableUrl = `http://${nodeIdentifier}/wara/${result.map.id}#${result.key}`;

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

    // DELETE /admin/delete/:id
    app.delete('/admin/delete/:id', node.requireAuth, async (req: Request, res: Response) => {
        const { id } = req.params;
        const link = node.links.get(id);
        if (!link) return res.status(404).json({ error: "Link not found" });

        try {
            node.links.delete(id);
            const waraPath = link.filePath;
            const jsonPath = waraPath.replace('.wara', '.json');
            if (fs.existsSync(waraPath)) fs.unlinkSync(waraPath);
            if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

            const dir = path.dirname(waraPath);
            try {
                const files = fs.readdirSync(dir);
                for (const f of files) {
                    if (f.startsWith(`${id}_`)) fs.unlinkSync(path.join(dir, f));
                }
            } catch (e) { }

            console.log(`[WaraNode] Deleted link: ${id}`);
            res.json({ success: true });
        } catch (e) {
            console.error("Delete failed", e);
            res.status(500).json({ error: "Failed to delete files" });
        }
    });

    // POST /admin/mirror
    app.post('/admin/mirror', node.requireAuth, async (req: Request, res: Response) => {
        try {
            const { outputUrl } = req.body;
            if (!outputUrl) return res.status(400).json({ error: "Missing outputUrl" });

            console.log(`[WaraNode] Mirroring content from ${outputUrl}...`);
            const mapRes = await fetch(`${outputUrl}/map`);
            if (!mapRes.ok) throw new Error("Could not fetch remote map");
            const map = await mapRes.json() as WaraMap;

            const streamUrl = `${outputUrl}/stream`;
            const response = await fetch(streamUrl);
            if (!response.ok || !response.body) throw new Error("Could not fetch remote stream");

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const localPath = path.join(node.dataDir, `${map.id}.wara`);
            fs.writeFileSync(localPath, buffer);
            fs.writeFileSync(path.join(node.dataDir, `${map.id}.json`), JSON.stringify(map, null, 2));

            node.registerLink(map.id, localPath, map);
            const effectiveHost = (node as any).publicIp ? (node as any).publicIp : 'localhost';

            res.json({
                success: true,
                linkId: map.id,
                mirroredFrom: outputUrl,
                map: { ...map, publicEndpoint: `http://${effectiveHost}:${node.port}/wara/${map.id}` }
            });
        } catch (e: any) {
            console.error(e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /admin/peer
    app.post('/admin/peer', node.requireAuth, (req: Request, res: Response) => {
        const { name, endpoint } = req.body;
        if (!name || !endpoint) return res.status(400).json({ error: 'Name and endpoint are required' });

        node.knownPeers.set(name, { endpoint, lastSeen: Date.now() });
        console.log(`[Admin] Manually added peer: ${name} (${endpoint})`);
        res.json({ success: true, message: `Peer "${name}" added successfully`, totalPeers: node.knownPeers.size });
    });

    // GET /admin/status
    app.get('/admin/status', node.requireAuth, async (req: Request, res: Response) => {

        // Force reload identity from disk to ensure consistency
        // This prevents the 'Register' form from reappearing if memory state was lost
        try {
            const idPath = path.join(node.dataDir, 'node_identity.json');
            if (fs.existsSync(idPath)) {
                const identity = JSON.parse(fs.readFileSync(idPath, 'utf-8'));

                // ALWAYS update memory state from disk truth
                if (identity.name) (node as any).nodeName = identity.name;
                if (identity.owner) (node as any).nodeOwner = identity.owner;

                // If signer is missing but we have key, restore it
                if (!(node as any).nodeSigner && identity.nodeKey) {
                    try {
                        const { ethers } = require('ethers');
                        (node as any).nodeSigner = new ethers.Wallet(identity.nodeKey, node.provider);
                    } catch (e) { }
                }
            }
        } catch (e) { }

        let diskSpace = null;
        try {
            const fsAny = fs as any;
            if (fsAny.statfsSync) {
                const stats = fsAny.statfsSync(node.dataDir);
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

        const nodeAny = node as any;
        let nodeBalance = '0';
        if (nodeAny.nodeSigner) {
            try {
                const bal = await nodeAny.provider.getBalance(nodeAny.nodeSigner.address);
                nodeBalance = require('ethers').formatEther(bal);
            } catch (e) { }
        }

        res.json({
            nodeId: nodeAny.nodeId,
            nodeName: nodeAny.nodeName,
            nodeOwner: nodeAny.nodeOwner, // Wallet humana
            nodeAddress: nodeAny.nodeSigner?.address,
            nodeBalance: nodeBalance,
            sentinel: nodeAny.sentinelStatus,
            config: { port: node.port, dataDir: node.dataDir, trackers: nodeAny.trackers },
            resources: systemInfo,
            network: { publicIp: nodeAny.publicIp, capacity: node.globalMaxStreams, region: (node as any).region },
            peers: node.knownPeers.size
        });
    });

    // GET /admin/catalog (Separated for performance)
    app.get('/admin/catalog', node.requireAuth, async (req: Request, res: Response) => {
        const content = await node.getResolvedCatalog();
        res.json({ success: true, content });
    });

    // POST /admin/identity
    app.post('/admin/identity', node.requireAuth, (req: Request, res: Response) => {
        const { name, nodeKey } = req.body;
        const idPath = path.join(node.dataDir, 'node_identity.json');
        if (fs.existsSync(idPath)) return res.status(403).json({ error: 'Node identity is locked.' });
        if (!name || !nodeKey) return res.status(400).json({ error: 'Name and nodeKey are required' });

        const identity = { name, nodeKey, createdAt: new Date().toISOString() };
        const finalName = name.includes('.wara') ? name : `${name}.wara`;

        const nodeAny = node as any;
        nodeAny.nodeName = finalName;
        try { const { ethers } = require('ethers'); nodeAny.nodeSigner = new ethers.Wallet(nodeKey); } catch (e) { }

        fs.writeFileSync(idPath, JSON.stringify(identity, null, 2));
        console.log(`[WaraNode] Identity LOCKED: ${finalName}`);
        res.json({ success: true, message: 'Identity locked successfully' });
    });

    // GET /admin/identity
    app.get('/admin/identity', node.requireAuth, (req: Request, res: Response) => {
        const idPath = path.join(node.dataDir, 'node_identity.json');
        if (fs.existsSync(idPath)) {
            const identity = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
            res.json({ locked: true, name: identity.name, createdAt: identity.createdAt });
        } else {
            res.json({ locked: false });
        }
    });

    // POST /admin/sync
    app.post('/admin/sync', node.requireAuth, async (req: Request, res: Response) => {
        const nodeAny = node as any;
        if (nodeAny.syncNetwork) nodeAny.syncNetwork();
        res.json({ success: true, message: 'Sync started' });
    });

    // POST /admin/trackers
    app.post('/admin/trackers', node.requireAuth, (req: Request, res: Response) => {
        const { trackers } = req.body;
        if (!Array.isArray(trackers)) return res.status(400).json({ error: 'trackers must be an array' });

        const nodeAny = node as any;
        nodeAny.trackers = trackers.filter((t: any) => typeof t === 'string' && t.length > 0);
        console.log(`[WaraNode] Trackers updated: ${nodeAny.trackers.join(', ')}`);

        if (nodeAny.saveTrackers) nodeAny.saveTrackers();

        if (nodeAny.heartbeatInterval) { clearInterval(nodeAny.heartbeatInterval); nodeAny.heartbeatInterval = null; }
        if (nodeAny.startHeartbeat) nodeAny.startHeartbeat();

        res.json({ success: true, trackers: nodeAny.trackers });
    });

    // --- NEW: Delete Endpoint ---
    app.delete('/admin/delete/:id', node.requireAuth, async (req: Request, res: Response) => {
        const { id } = req.params;
        const link = node.links.get(id);

        if (!link) {
            return res.status(404).json({ error: "Link not found" });
        }

        try {
            // 1. Remove from Memory
            node.links.delete(id);

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

            console.log(`[WaraNode] Deleted link: ${id}`);
            res.json({ success: true });

        } catch (e) {
            console.error("Delete failed", e);
            res.status(500).json({ error: "Failed to delete files" });
        }
    });

    // --- NEW: Mirror Endpoint (Replication) ---
    app.post('/admin/mirror', node.requireAuth, async (req: Request, res: Response) => {
        try {
            const { outputUrl } = req.body; // e.g. "http://192.168.1.5:21746/wara/abc12345"
            if (!outputUrl) return res.status(400).json({ error: "Missing outputUrl" });

            console.log(`[WaraNode] Mirroring content from ${outputUrl}...`);

            // 1. Fetch Map
            const mapRes = await fetch(`${outputUrl}/map`);
            if (!mapRes.ok) throw new Error("Could not fetch remote map");
            const map = await mapRes.json() as WaraMap;

            // 2. Stream Download Encrypted Content
            // We stream it directly to our disk NO DECRYPTION needed (blind replication)

            const streamUrl = `${outputUrl}/stream`;
            const response = await fetch(streamUrl);
            if (!response.ok || !response.body) throw new Error("Could not fetch remote stream");

            // Use built-in node fetch with stream or standard https module?
            // Node 18+ fetch has body as a Web Stream, but we need Node Stream for fs
            // Let's assume we are in environment where we can convert or just read buffer for MVP.
            // For big files, we should use stream pipeline.

            // Simple approach for MVP: ArrayBuffer -> Buffer -> File
            // Warning: RAM heavy for big files. Better utilize stream.

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const localPath = path.join(node.dataDir, `${map.id}.wara`);
            fs.writeFileSync(localPath, buffer);

            // 3. Save Map JSON
            fs.writeFileSync(path.join(node.dataDir, `${map.id}.json`), JSON.stringify(map, null, 2));

            // 4. Register
            node.registerLink(map.id, localPath, map);

            const effectiveHost = node.publicIp ? node.publicIp : 'localhost';
            const responseMap = {
                ...map,
                publicEndpoint: `http://${effectiveHost}:${node.port}/wara/${map.id}`
            };

            res.json({
                success: true,
                linkId: map.id,
                mirroredFrom: outputUrl,
                map: responseMap
            });

        } catch (e) {
            console.error(e);
            res.status(500).json({ error: (e as Error).message });
        }
    });

    // --- Admin: Cache Image (For P2P Metadata) ---
    app.post('/admin/cache-image', node.requireAuth, (req: Request, res: Response) => {
        const imagePath = req.headers['x-image-path'] as string;

        if (!imagePath || imagePath.includes('..')) {
            return res.status(400).json({ error: 'Invalid image path' });
        }

        const fullPath = path.join(node.dataDir, imagePath);
        const dir = path.dirname(fullPath);

        // Create directory if it doesn't exist
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const writeStream = fs.createWriteStream(fullPath);
        req.pipe(writeStream);

        writeStream.on('finish', () => {
            console.log(`[WaraNode] Cached image: ${imagePath}`);
            res.json({ success: true, path: imagePath });
        });

        writeStream.on('error', (err) => {
            console.error("Image cache failed", err);
            res.status(500).json({ error: "Write failed" });
        });
    });

    // --- Admin: Upload Subtitle ---
    app.post('/admin/subtitle', node.requireAuth, (req: Request, res: Response) => {
        const linkId = req.headers['x-link-id'] as string;
        const lang = req.headers['x-lang'] as string;
        const label = req.headers['x-label'] as string;
        const filename = req.headers['x-filename'] as string;

        if (!linkId || !lang || !node.links.has(linkId)) {
            return res.status(404).json({ error: 'Link not found' });
        }

        const link = node.links.get(linkId)!;
        // Determine extension. Prefer vtt.
        let ext = 'vtt';
        if (filename && filename.endsWith('.srt')) ext = 'srt';

        const subFileName = `${linkId}_${lang}.${ext}`;
        const subFilePath = path.join(node.dataDir, subFileName);

        const writeStream = fs.createWriteStream(subFilePath);
        req.pipe(writeStream);

        writeStream.on('finish', () => {
            // Cleanup conflicting extensions (priority issue)
            const otherExt = ext === 'vtt' ? 'srt' : 'vtt';
            const otherFile = path.join(node.dataDir, `${linkId}_${lang}.${otherExt}`);
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
                const mapPath = path.join(node.dataDir, `${linkId}.json`);
                fs.writeFileSync(mapPath, JSON.stringify(link.map, null, 2));
                console.log(`[WaraNode] Subtitle added: ${lang} for ${linkId}`);
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


    //--Proof admin

    app.get('/admin/proofs', node.requireAuth, async (req: Request, res: Response) => {
        try {
            const { hoster } = req.query;
            const signer = node.getAuthenticatedSigner(req);
            if (!signer) return res.status(401).json({ error: 'Authentication required' });

            const targetWallet = ((hoster as string) || signer.address).toLowerCase();
            const proofsDir = path.join(node.dataDir, 'proofs');
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

    // --- NEW: Batch Delete Proofs (After on-chain claim) ---
    app.post('/admin/proofs/delete', node.requireAuth, (req: Request, res: Response) => {
        const { filenames } = req.body;
        if (!Array.isArray(filenames)) return res.status(400).json({ error: 'Filenames array required' });

        const proofsDir = path.join(node.dataDir, 'proofs');
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

        console.log(`[WaraNode] Deleted ${deleted} claimed proofs.`);
        res.json({ success: true, deleted });
    });

    // --- NEW: Batch Delete Votes (After on-chain sync) ---
    app.post('/admin/votes/delete', node.requireAuth, (req: Request, res: Response) => {
        const { filenames } = req.body;
        if (!Array.isArray(filenames)) return res.status(400).json({ error: 'Filenames array required' });

        const votesDir = path.join(node.dataDir, 'votes');
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

        console.log(`[WaraNode] Deleted ${deleted} synced votes.`);
        res.json({ success: true, deleted });
    });

};
