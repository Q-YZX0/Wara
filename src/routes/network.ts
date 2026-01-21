import { Router, Request, Response } from 'express';
import { WaraNode } from '../node';

//Organizar endpoints
export const setupNetworkRoutes = (node: WaraNode) => {
    const router = Router();
    // GET /identity (Expose technical wallet for voting rewards)
    router.get('/identity', (req: Request, res: Response) => {
        if (!node.nodeSigner) return res.status(500).json({ error: 'Node identity not initialized' });
        res.json({
            nodeAddress: node.nodeSigner.address,
            nodeName: node.nodeName || null,
            publicIp: node.publicIp || null
        });
    });

    // --- Gossip / Discovery (Phonebook) ---
    router.get('/peers', async (req: Request, res: Response) => {
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
    router.post('/gossip', (req: Request, res: Response) => {
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
    router.post('/connect', async (req: Request, res: Response) => {
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
                const resPeers = await fetch(`${endpoint}/api/network/peers`).then(r => r.json());
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

    // ==========================================
    // COMMUNITY RPC PROXY (Collaborative Infrastructure)
    // ==========================================

    // POST /rpc-proxy (Handle JSON-RPC requests from fellow nodes)
    router.post('/rpc-proxy', async (req: Request, res: Response) => {
        // Simple Guard: No userSigner? No Proxy.
        // We could add more complex auth based on on-chain subscription later.

        try {
            const rpcBody = req.body;
            // Record usage for fairness
            node.rpcManager.trackRequest();

            // Forward to internal provider's endpoint
            const result = await node.provider.send(rpcBody.method, rpcBody.params);
            res.json({
                jsonrpc: "2.0",
                id: rpcBody.id,
                result: result
            });
        } catch (e: any) {
            console.warn(`[RPCProxy] Proxy error: ${e.message}`);
            res.status(500).json({
                jsonrpc: "2.0",
                id: req.body.id,
                error: { code: -32000, message: e.message }
            });
        }
    });

    // GET /api/network/rpcs (List of community RPC endpoints)
    router.get('/rpcs', (req: Request, res: Response) => {
        const communityList = [
            'https://eth-sepolia.public.blastapi.io',
            'https://rpc.ankr.com/eth_sepolia',
            'https://rpc2.sepolia.org'
        ];

        // Add peers that are providing RPC service
        const peersProvidingRpc = Array.from(node.knownPeers.values())
            .filter(p => p.isTrusted) // Only trust verified nodes
            .map(p => `${p.endpoint}/api/network/rpc-proxy`);

        res.json({
            default: communityList,
            community: peersProvidingRpc
        });
    });

    return router;
};