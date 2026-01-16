import { Express, Request, Response } from 'express';
import { WaraNode } from '../node';

export const setupVoteRoutes = (app: Express, node: WaraNode) => {

    // POST /api/votes/signer (Sign & Relay to Remote Node)
    app.post('/api/votes/signer', async (req: Request, res: Response) => {
        const { linkId, contentHash, voteValue } = req.body;
        if (!linkId || !contentHash || !voteValue) {
            return res.status(400).json({ error: 'Missing params (need linkId, contentHash, voteValue)' });
        }

        try {
            const { ethers } = await import('ethers');

            // 1. Get authenticated signer from session (using authToken)
            const userSigner = node.getAuthenticatedSigner(req);
            if (!userSigner) return res.status(401).json({ error: 'Authentication required. Please login.' });

            // Get voter address from authenticated signer (don't trust frontend)
            const voter = userSigner.address;

            // 2. Lookup link in database to get hosterAddress
            const link = await node.prisma.link.findUnique({ where: { id: linkId } });
            if (!link) return res.status(404).json({ error: 'Link not found' });

            const hosterAddress = link.uploaderWallet;
            if (!hosterAddress) return res.status(400).json({ error: 'Link has no hoster address' });

            // 3. Prepare common vote data
            const meta = JSON.parse(link.waraMetadata || '{}');
            const salt = meta.salt || link.title || "default-salt";
            const hexContentHash = contentHash.startsWith('0x') ? contentHash : `0x${contentHash}`;

            const onChainLinkId = ethers.keccak256(
                ethers.solidityPacked(
                    ["bytes32", "address", "string", "bytes32"],
                    [hexContentHash, hosterAddress, salt, link.waraId]
                )
            );

            const nonce = Date.now();
            const timestamp = Math.floor(Date.now() / 1000);

            if (voteValue === 1) {
                // UPVOTE: Sign for Hoster and relay once (The hoster picks it up)
                const relayer = hosterAddress;
                const messageHash = ethers.solidityPackedKeccak256(
                    ["bytes32", "bytes32", "int8", "address", "address", "uint256", "uint256"],
                    [onChainLinkId, hexContentHash, voteValue, voter, relayer, nonce, timestamp]
                );
                const signature = await userSigner.signMessage(ethers.getBytes(messageHash));

                // Resolve target URL
                let targetUrl = link.url;
                if (link.url) {
                    try {
                        const url = new URL(link.url);
                        const hostname = url.hostname;
                        const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname === 'localhost';
                        if (!isIpAddress) {
                            const peer = node.knownPeers.get(hostname);
                            if (peer) targetUrl = peer.endpoint;
                        }
                    } catch (e) { }
                }

                console.log(`[Vote] Upvote signed for Hoster: ${relayer}. Relaying to ${targetUrl}`);
                const response = await fetch(`${targetUrl}/api/votes/submit`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ linkId, contentHash, voteValue, voter, relayer, signature, nonce, timestamp })
                });

                res.json({ success: true, relayedTo: targetUrl });

            } else {
                // DOWNVOTE: Sign for multiple peers to "repartir los votos" (Rewards for whoever submits)
                const peers = Array.from(node.knownPeers.values()).filter(p => p.walletAddress);
                const targets = peers.sort(() => 0.5 - Math.random()).slice(0, 5); // Random 5 peers

                if (targets.length === 0) {
                    // Fallback: Sign for our own node and submit locally
                    const relayer = node.nodeSigner?.address || ethers.ZeroAddress;
                    const messageHash = ethers.solidityPackedKeccak256(
                        ["bytes32", "bytes32", "int8", "address", "address", "uint256", "uint256"],
                        [onChainLinkId, hexContentHash, voteValue, voter, relayer, nonce, timestamp]
                    );
                    const signature = await userSigner.signMessage(ethers.getBytes(messageHash));

                    console.log(`[Vote] No peers found for downvote. Relaying to self...`);
                    await fetch(`http://localhost:${node.port}/api/votes/submit`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ linkId, contentHash, voteValue, voter, relayer, signature, nonce, timestamp })
                    });
                    res.json({ success: true, relayedTo: 'local' });
                } else {
                    console.log(`[Vote] Signing downvote for ${targets.length} peers...`);

                    const relays = await Promise.allSettled(targets.map(async (peer) => {
                        const relayer = peer.walletAddress;
                        const messageHash = ethers.solidityPackedKeccak256(
                            ["bytes32", "bytes32", "int8", "address", "address", "uint256", "uint256"],
                            [onChainLinkId, hexContentHash, voteValue, voter, relayer, nonce, timestamp]
                        );
                        const signature = await userSigner.signMessage(ethers.getBytes(messageHash));

                        return fetch(`${peer.endpoint}/api/votes/submit`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ linkId, contentHash, voteValue, voter, relayer, signature, nonce, timestamp })
                        });
                    }));

                    res.json({ success: true, relayedToPeers: targets.length });
                }
            }
        } catch (e: any) {
            console.error("Signer relay failed", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/votes/submit
    app.post('/api/votes/submit', async (req: Request, res: Response) => {
        const { linkId, contentHash, voteValue, voter, relayer, signature, nonce, timestamp } = req.body;
        if (!linkId || !contentHash || !voteValue || !voter || !signature || !relayer) return res.status(400).json({ error: 'Missing params' });

        try {
            const { ethers } = await import('ethers');
            const link = await node.prisma.link.findUnique({ where: { id: linkId } });
            if (!link) return res.status(404).json({ error: 'Link not found' });

            const meta = JSON.parse(link.waraMetadata || '{}');
            const salt = meta.salt || link.title || "default-salt";
            const hexContentHash = contentHash.startsWith('0x') ? contentHash : `0x${contentHash}`;
            const hosterAddress = link.uploaderWallet;

            // FORMULA: keccak256(abi.encodePacked(contentHash, hoster, salt, waraId))
            const onChainLinkId = ethers.keccak256(
                ethers.solidityPacked(
                    ["bytes32", "address", "string", "bytes32"],
                    [hexContentHash, hosterAddress, salt, link.waraId]
                )
            );

            const messageHash = ethers.solidityPackedKeccak256(
                ["bytes32", "bytes32", "int8", "address", "address", "uint256", "uint256"],
                [onChainLinkId, hexContentHash, voteValue, voter, relayer, nonce, timestamp]
            );
            const recoveredAddress = ethers.verifyMessage(ethers.getBytes(messageHash), signature);

            if (recoveredAddress.toLowerCase() !== voter.toLowerCase()) return res.status(401).json({ error: 'Invalid signature' });

            const existingVote = await node.prisma.linkVote.findUnique({
                where: { linkId_voterWallet: { linkId: linkId, voterWallet: voter } }
            });

            if (existingVote) return res.status(409).json({ error: 'Vote already submitted' });

            const vote = await node.prisma.linkVote.create({
                data: { linkId, voterWallet: voter, value: voteValue }
            });

            const updatedLink = await node.prisma.link.update({
                where: { id: linkId },
                data: {
                    trustScore: { increment: voteValue },
                    upvotes: { increment: voteValue === 1 ? 1 : 0 },
                    downvotes: { increment: voteValue === -1 ? 1 : 0 }
                },
                include: { _count: { select: { votes: true } } }
            });

            // Save Signed Vote to Disk for Batch Claiming
            const fs = await import('fs');
            const path = await import('path');
            const votesDir = path.join(node.dataDir, 'votes');
            if (!fs.existsSync(votesDir)) fs.mkdirSync(votesDir, { recursive: true });

            // Filename: timestamp_voter_link.json
            const votePath = path.join(votesDir, `${Date.now()}_${voter.slice(0, 8)}_${linkId.slice(0, 8)}.json`);

            const votePayload = {
                linkId,
                voteValue,
                voter,
                relayer,
                nonce,
                timestamp,
                signature,
                contentHash
            };

            fs.writeFileSync(votePath, JSON.stringify(votePayload, null, 2));
            console.log(`[Vote] Saved signed vote to ${votePath}`);

            // ==========================================
            // GOSSIP PROTOCOL (For Downvotes/Censorship Resistance)
            // ==========================================
            if (voteValue === -1) {
                // Propagate negative votes to ensure network awareness
                // Avoid infinite loops by probability or checking if we already had it (we check DB existence above)
                // Since checkDB stopped duplicates, we are safe to re-gossip if it's new to US.

                const peers = Array.from(node.knownPeers.values());
                if (peers.length > 0) {
                    // Pick 3 random peers
                    const targets = peers.sort(() => 0.5 - Math.random()).slice(0, 3);

                    console.log(`[Vote] Gossiping downvote to ${targets.length} peers...`);

                    // Fire and forget - don't await
                    Promise.allSettled(targets.map(peer =>
                        fetch(`${peer.url}/api/votes/submit`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(req.body) // Forward original payload
                        }).catch(err => console.error(`Gossip failed to ${peer.url}`, err.message))
                    ));
                }
            }

            console.log(`[Vote] Submitted ${voteValue > 0 ? 'UPVOTE' : 'DOWNVOTE'} for link ${linkId} by ${voter}`);
            res.json({ success: true, vote: { ...vote, link: updatedLink } });
        } catch (e: any) {
            console.error("Vote submission failed:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/votes/received?wallet=0x... - Get votes received by this hoster (on their links)
    app.get('/api/votes/received', async (req: Request, res: Response) => {
        try {
            const { wallet } = req.query;
            const signer = node.getAuthenticatedSigner(req);
            const targetWallet = (wallet as string || signer?.address || "").toLowerCase();

            if (!targetWallet) return res.status(400).json({ error: 'Missing wallet or session' });

            const fs = await import('fs');
            const path = await import('path');
            const votesDir = path.join(node.dataDir, 'votes');
            const results: any[] = [];

            // 1. Try DB first (Fastest/Rich Data)
            try {
                const dbVotes = await node.prisma.linkVote.findMany({
                    where: { link: { uploaderWallet: targetWallet } },
                    include: { link: true },
                    orderBy: { createdAt: 'desc' }
                });
                if (dbVotes.length > 0) return res.json({ votes: dbVotes });
            } catch (e) { }

            // 2. Fallback to Disk (Resilience if DB formatted)
            if (fs.existsSync(votesDir)) {
                const files = fs.readdirSync(votesDir).filter(f => f.endsWith('.json'));
                const linkIds = new Set<string>();
                const diskVotes: any[] = [];

                for (const f of files) {
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(votesDir, f), 'utf8'));
                        diskVotes.push(data);
                        linkIds.add(data.linkId);
                    } catch (e) { }
                }

                // We need to know which links belong to this wallet
                const myLinks = await node.prisma.link.findMany({
                    where: { id: { in: Array.from(linkIds) }, uploaderWallet: targetWallet },
                    select: { id: true, title: true }
                });

                const myLinkSet = new Set(myLinks.map(l => l.id));
                const linkMap = new Map(myLinks.map(l => [l.id, l]));

                const filtered = diskVotes
                    .filter(v => myLinkSet.has(v.linkId))
                    .map(v => ({ ...v, link: linkMap.get(v.linkId) }));

                return res.json({ votes: filtered });
            }

            res.json({ votes: [] });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/votes/pending?wallet=0x... - Get votes I HAVE SENT that are on this node
    app.get('/api/votes/pending', async (req: Request, res: Response) => {
        try {
            const { wallet } = req.query;
            const signer = node.getAuthenticatedSigner(req);
            const targetWallet = (wallet as string || signer?.address || "").toLowerCase();

            if (!targetWallet) return res.status(400).json({ error: 'Missing wallet or session' });

            const fs = await import('fs');
            const path = await import('path');
            const votesDir = path.join(node.dataDir, 'votes');
            const searchVal = targetWallet;

            if (!fs.existsSync(votesDir)) return res.json({ votes: [] });

            const files = fs.readdirSync(votesDir).filter(f => f.endsWith('.json'));
            const myVotes: any[] = [];

            for (const f of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(votesDir, f), 'utf8'));
                    if (data.voter && data.voter.toLowerCase() === searchVal) {
                        // Try to attach link title from DB if available
                        const link = await node.prisma.link.findUnique({ where: { id: data.linkId } });
                        myVotes.push({ ...data, link });
                    }
                } catch (e) { }
            }

            res.json({ votes: myVotes });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });
};