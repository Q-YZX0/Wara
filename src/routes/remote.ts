import { Router, Request, Response } from 'express';
import { WaraNode } from '../node';

export const setupRemoteRoutes = (node: WaraNode) => {
    const router = Router();
    // GET /api/remote-nodes
    router.get('/api/remote-nodes', async (req: Request, res: Response) => {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });
        try {
            const nodes = await node.prisma.remoteNode.findMany({ where: { userId: String(userId) } });
            res.json({ nodes });
        } catch (e) {
            res.status(500).json({ error: 'Failed to fetch nodes' });
        }
    });

    // POST /api/remote-nodes
    router.post('/api/remote-nodes', async (req: Request, res: Response) => {
        const { userId, url, nodeKey, name, password } = req.body;
        if (!userId || !url) return res.status(400).json({ error: 'Missing userId or url' });

        try {
            const { encryptPayload } = await import('../encryption');

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

    // DELETE /api/remote-nodes
    router.delete('/api/remote-nodes', async (req: Request, res: Response) => {
        const { nodeId, userId } = req.query;
        if (!nodeId || !userId) return res.status(400).json({ error: 'Missing parameters' });
        try {
            const deleted = await node.prisma.remoteNode.deleteMany({ where: { id: String(nodeId), userId: String(userId) } });
            res.json({ success: deleted.count > 0 });
        } catch (e) {
            res.status(500).json({ error: 'Failed to delete node' });
        }
    });

    // POST /api/remote-nodes/decrypt
    router.post('/api/remote-nodes/decrypt', async (req: Request, res: Response) => {
        const { nodeId, userId, password } = req.body;
        if (!nodeId || !userId || !password) return res.status(400).json({ error: 'Missing parameters or password' });

        try {
            const { decryptPayload } = await import('../encryption');

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

    return router;
};
