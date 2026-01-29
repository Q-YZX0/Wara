import { Router, Request, Response } from 'express';
import { App } from '../../App';
import { encryptPayload, decryptPayload } from '../../utils/encryption';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../../config/config';
import { ethers } from 'ethers';

export const setupNodesRoutes = (node: App) => {
    const router = Router();
    // GET /api/manager/node    
    // List of nodes managed by the user
    router.get('/node', async (req: Request, res: Response) => {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });
        try {
            const nodes = await node.prisma.remoteNode.findMany({ where: { userId: String(userId) } });
            res.json({ nodes });
        } catch (e) {
            res.status(500).json({ error: 'Failed to fetch nodes' });
        }
    });

    // POST /api/manager/node
    // Add a new node for the user
    router.post('/node', async (req: Request, res: Response) => {
        const { userId, url, nodeKey, name, password } = req.body;
        if (!userId || !url) return res.status(400).json({ error: 'Missing userId or url' });

        try {


            const userExists = await node.prisma.localProfile.findUnique({ where: { id: String(userId) } });
            if (!userExists) return res.status(404).json({ error: 'User not found' });

            // Encrypt the nodeKey with the USER'S PASSWORD
            // This ensures only the user can decrypt it later
            let encryptedKey = null;
            if (nodeKey && password) {
                encryptedKey = encryptPayload(nodeKey, password);
            } else if (nodeKey) {
                return res.status(400).json({ error: 'Password required to encrypt admin key securely' });
            }

            const newNode = await node.prisma.remoteNode.create({
                data: {
                    userId: String(userId),
                    url: String(url),
                    name: String(name || url),
                    encryptedKey: encryptedKey
                }
            });
            res.json({ success: true, node: newNode });
        } catch (e: any) {
            res.status(500).json({ error: 'Failed to add remote node', details: e.message });
        }
    });

    // DELETE /api/manager/node
    // Delete a node for the user
    router.delete('/node', async (req: Request, res: Response) => {
        const { nodeId, userId } = req.query;
        if (!nodeId || !userId) return res.status(400).json({ error: 'Missing parameters' });
        try {
            const deleted = await node.prisma.remoteNode.deleteMany({ where: { id: String(nodeId), userId: String(userId) } });
            res.json({ success: deleted.count > 0 });
        } catch (e) {
            res.status(500).json({ error: 'Failed to delete node' });
        }
    });

    // POST /api/manager/node-decrypt
    // Decrypt the nodeKey with the USER'S PASSWORD
    router.post('/node-decrypt', async (req: Request, res: Response) => {
        const { nodeId, userId, password } = req.body;
        if (!nodeId || !userId || !password) return res.status(400).json({ error: 'Missing parameters or password' });

        try {
            const remoteNode = await node.prisma.remoteNode.findFirst({ where: { id: String(nodeId), userId: String(userId) } });
            if (!remoteNode) return res.status(404).json({ error: 'Node not found' });

            if (!remoteNode.encryptedKey) {
                return res.json({ key: '' }); // No key stored
            }

            try {
                const decryptedKey = decryptPayload(remoteNode.encryptedKey, password);
                res.json({ key: decryptedKey });
            } catch (decErr) {
                return res.status(401).json({ error: 'Invalid password. Cannot decrypt key.' });
            }

        } catch (e) {
            res.status(500).json({ error: 'Failed to fetch key' });
        }
    });

    // GET /api/manager/health - Simple health check for monitoring
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

    // GET /api/manager/status
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
            console.error("System info failed:", e);
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

    return router;
};
