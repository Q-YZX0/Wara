import { Express, Request, Response } from 'express';
import { WaraNode } from '../node';

export const setupNetworkRoutes = (app: Express, node: WaraNode) => {

    // GET /api/network/identity (Expose technical wallet for voting rewards)
    app.get('/api/network/identity', (req: Request, res: Response) => {
        if (!node.nodeSigner) return res.status(500).json({ error: 'Node identity not initialized' });
        res.json({
            nodeAddress: node.nodeSigner.address,
            nodeName: node.nodeName || null,
            publicIp: node.publicIp || null
        });
    });


    // --- Gossip / Discovery (Phonebook) ---
    app.get('/peers', async (req: Request, res: Response) => {
        // Return my own info + everyone I know
        const peers = Array.from(node.knownPeers.entries()).map(([name, data]) => ({
            name,
            endpoint: data.endpoint,
            lastSeen: data.lastSeen,
            signature: data.signature
        }));

        // Add myself if I have an identity
        if (node.nodeSigner && node.publicIp) {
            const identifier = node.nodeName || node.nodeSigner.address;
            const endpoint = `http://${node.publicIp}:${node.port}`;
            const message = `WaraNode:${identifier}:${endpoint}`;
            const signature = await node.nodeSigner.signMessage(message);

            peers.push({
                name: identifier,
                endpoint: endpoint,
                lastSeen: Date.now(),
                signature: signature
            });
        }

        res.json(peers);
    });

    // Receive gossip from others
    app.post('/gossip', (req: Request, res: Response) => {
        const { peers } = req.body; // Array of {name, endpoint}
        if (Array.isArray(peers)) {
            let newPeers = 0;
            peers.forEach(async (p: any) => {
                if (p.name && p.endpoint && p.name !== node.nodeName) {
                    // Cryptographic Verification
                    const verified = await node.verifyPeerIdentity(p.name, p.endpoint, p.signature);

                    // Update phonebook
                    node.knownPeers.set(p.name, {
                        endpoint: p.endpoint,
                        lastSeen: Date.now(),
                        signature: p.signature,
                        walletAddress: verified?.address,
                        isTrusted: !!verified
                    });
                    newPeers++;
                }
            });
            if (newPeers > 0) {
                console.log(`[Gossip] Updated ${newPeers} peer locations.`);
                node.savePeers();
            }
        }
        res.json({ success: true });
    });

    // POST /api/network/connect - Manual Sentinel Connection (Unified)
    app.post('/api/network/connect', async (req: Request, res: Response) => {
        const { target } = req.body; // Can be "salsa.muggi" or "http://IP:PORT"

        if (!target) return res.status(400).json({ error: 'Target required (name or url)' });

        let name: string | undefined;
        let endpoint: string | undefined;

        // 1. Detect Type
        const isUrl = target.startsWith('http') || target.includes(':');

        if (isUrl) {
            // It's an IP/URL -> Auto-discover Name
            endpoint = target;
            console.log(`[Network] Target detected as URL: ${endpoint}. Finding name...`);
            try {
                const resPeers = await fetch(`${endpoint}/peers`).then(r => r.json());
                const self = Array.isArray(resPeers) ? resPeers.find((p: any) => p.endpoint && (p.endpoint.includes(endpoint!) || endpoint!.includes(p.endpoint))) : null;
                if (self && self.name) {
                    name = self.name;
                    console.log(`[Network] Discovered name: ${name}`);
                }
            } catch (e) { /* Ignore check failure */ }

            // If name is still unknown, use IP as fallback name or error?
            // Let's use IP as name for raw connections if discovery fails
            if (!name) name = endpoint;
        } else {
            // It's a Name -> Resolve IP via Sentinel
            name = target;
            console.log(`[Network] Target detected as Name: ${name}. Resolving Sentinel IP...`);
            // resolveSentinelNode returns Promise<string | null>
            const resolved = await node.resolveSentinelNode(name!);
            if (!resolved) {
                return res.status(404).json({ error: `Could not resolve IP for ${name}` });
            }
            endpoint = resolved;
        }

        // 2. Connect
        if (name && endpoint) {
            node.knownPeers.set(name, {
                endpoint,
                lastSeen: Date.now(),
                signature: undefined
            });
            console.log(`[Network] Connected to ${name} @ ${endpoint}`);
            res.json({ success: true, name, endpoint });
        } else {
            res.status(500).json({ error: "Failed to resolve connection" });
        }
    });

    // GET /api/nodes/resolve?address=0x... - Resolve wallet address to node URL
    app.get('/api/nodes/resolve', async (req: Request, res: Response) => {
        const { address } = req.query;
        if (!address) return res.status(400).json({ error: 'Missing address' });

        try {
            const searchAddress = String(address).toLowerCase();

            // 1. Check if it's the local node owner
            const nodeAny = node as any;
            if (nodeAny.nodeOwner && nodeAny.nodeOwner.toLowerCase() === searchAddress) {
                const publicIp = nodeAny.publicIp || 'localhost';
                return res.json({ url: `http://${publicIp}:${node.port}` });
            }

            // 2. Check if we have links hosted by this address
            const link = await node.prisma.link.findFirst({
                where: {
                    OR: [
                        { uploaderWallet: searchAddress },
                        { waraMetadata: { contains: searchAddress } } // Check if hosterAddress is in metadata
                    ]
                }
            });

            if (link) {
                // This link is hosted locally
                const publicIp = nodeAny.publicIp || 'localhost';
                return res.json({ url: `http://${publicIp}:${node.port}` });
            }

            // 3. Not found - could query blockchain registry here in future
            res.status(404).json({ error: 'Node URL not found for this address' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/network/peers - Get list of known peers for gossip
    app.get('/api/network/peers', (req: Request, res: Response) => {
        const peers = Array.from(node.knownPeers.entries()).map(([name, peer]) => ({
            name,
            url: peer.endpoint
        }));
        res.json({ peers });
    });

    // --- Tracker Management ---
    app.get('/api/network/trackers', (req: Request, res: Response) => {
        res.json({ trackers: node.getTrackers() });
    });

    app.post('/api/network/trackers', (req: Request, res: Response) => {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'Missing tracker URL' });

        node.addTracker(url);
        res.json({ success: true, trackers: node.getTrackers() });
    });

    app.delete('/api/network/trackers', (req: Request, res: Response) => {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'Missing tracker URL' });

        node.removeTracker(String(url));
        res.json({ success: true, trackers: node.getTrackers() });
    });
};