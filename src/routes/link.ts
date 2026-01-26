import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import axios from 'axios';
import { App } from '../App';
import { getMediaMetadata } from '../utils/tmdb';
import * as path from 'path';
import * as fs from 'fs';
import { CONFIG, ABIS } from '../config/config';

export const setupLinkRoutes = (node: App) => {
    const router = Router();
    // Get filtered links
    router.get('/', async (req: Request, res: Response) => {
        try {
            const { sourceId, source = 'tmdb', mediaType, season, episode } = req.query;
            if (!sourceId || !mediaType) return res.status(400).json({ error: 'Missing filter' });

            const where: any = {
                source: String(source),
                sourceId: String(sourceId),
                mediaType: String(mediaType)
            };
            if (season) where.season = parseInt(season as string);
            if (episode) where.episode = parseInt(episode as string);

            const links = await node.prisma.link.findMany({
                where,
                orderBy: { createdAt: 'desc' }
            });

            // Resolve portable URLs for frontend
            const isLocalRequest = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1' || req.hostname === 'localhost';

            const resolvedLinks = await Promise.all(links.map(async (link) => {
                let resolvedUrl = link.url;

                try {
                    // NEW STANDARD: 'link.url' field contains the Host Authority ONLY (e.g., "salsa.wara", "0x123...", "192.168.1.50")
                    const hostname = link.url;
                    const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname === 'localhost';

                    if (isIpAddress) {
                        // 1. IP Authority
                        // NAT Loopback Fix: If it's my own public IP and I am requesting locally, switch to localhost
                        if (hostname === node.identity.publicIp && isLocalRequest) {
                            resolvedUrl = `http://localhost:${CONFIG.PORT}/stream/${link.id}`;
                        } else {
                            // Standard IP Construction
                            resolvedUrl = `http://${hostname}:${CONFIG.PORT}/stream/${link.id}`;
                        }
                    } else {
                        // 2. Named Authority (muggi.wara, 0x123...)
                        const identifier = hostname;

                        // Check if it IS my own identity
                        const isLocalByName = identifier.includes('.wara') && node.identity.nodeName && identifier === node.identity.nodeName;

                        if (isLocalByName) {
                            // Local link -> use localhost OR Public IP depending on requester
                            const targetBase = isLocalRequest ? `localhost:${CONFIG.PORT}` : `${node.identity.publicIp}:${CONFIG.PORT}`;
                            resolvedUrl = `http://${targetBase}/stream/${link.id}`;
                        } else {
                            // Remote Named Link -> Resolve via Peer Table
                            let resolvedEndpoint = null;

                            // Iterate known peers to find the IP associated with this Authority Name
                            for (const [peerName, peer] of node.p2p.knownPeers.entries()) {
                                const matchByName = identifier.includes('.wara') && peerName === identifier;
                                const matchByAddress = identifier.startsWith('0x') && peer.walletAddress && peer.walletAddress.toLowerCase() === identifier.toLowerCase();

                                if (matchByName || matchByAddress) {
                                    resolvedEndpoint = peer.endpoint;
                                    break;
                                }
                            }

                            if (resolvedEndpoint) {
                                // Peer Found: Construct proper endpoint URL
                                resolvedUrl = `${resolvedEndpoint}/stream/${link.id}`;
                            } else {
                                // Peer Not Found / Offline:
                                // Fallback: Try to resolve DNS-like if possible (e.g. .local), otherwise broken link until peer syncs.
                                resolvedUrl = `http://${hostname}/stream/${link.id}`;
                            }
                        }
                    }
                } catch (e) {
                    // unexpected error
                }

                return { ...link, url: resolvedUrl };
            }));

            res.json(resolvedLinks);
        } catch (e) {
            res.status(500).json({ error: 'Failed to fetch links' });
        }
    });

    // Create new link (Authenticated & Robust)
    router.post('/', async (req: Request, res: Response) => {
        const { sourceId, source = 'tmdb', mediaType, url, title, waraMetadata, season, episode } = req.body;

        if (!sourceId || !url || !title) return res.status(400).json({ error: 'Missing fields' });

        // 0. Strict Identity Check (Must be an active USER session)
        const authToken = (req.headers['x-auth-token'] || req.body.authToken) as string;
        const signer = node.identity.activeWallets.get(authToken);
        if (!signer) return res.status(401).json({ error: "Unauthorized: Active USER session required" });

        let media: any = null;
        try {
            // 1. Ensure Media Exists
            media = await node.prisma.media.findUnique({
                where: {
                    source_sourceId: { source: String(source), sourceId: String(sourceId) }
                }
            });

            // 1.1 Ownership Check for Blessing decision
            let isContractOwner = false;
            if (node.blockchain.mediaRegistry) {
                try {
                    const ownerAddress = await node.blockchain.mediaRegistry.owner();
                    isContractOwner = (signer.address.toLowerCase() === ownerAddress.toLowerCase());
                } catch (e) {
                    console.warn("[Link] Could not verify contract ownership.");
                }
            }

            if (!media) {
                console.log(`[WaraNode] Enriching new media ${sourceId} from ${source} for incoming link...`);
                // Use isContractOwner to decide initial status
                const statusTarget = isContractOwner ? 'approved' : 'pending_dao';
                media = await getMediaMetadata(node.prisma, String(sourceId), mediaType || 'movie', statusTarget, node);
            }

            if (!media) return res.status(404).json({ error: 'Media not found on Source' });

            // --- PHASE 4: Proof of Availability & Content Sealing ---
            const linkId = url.split('/').pop()?.split('#')[0]; // Extract linkId from wara://.../linkId#key
            if (!linkId) return res.status(400).json({ error: 'Invalid URL format: Could not extract linkId' });

            const tempBase = path.join(CONFIG.DATA_DIR, 'temp');
            const permBase = path.join(CONFIG.DATA_DIR, 'permanent');
            const tempWara = path.join(tempBase, `${linkId}.wara`);
            const permWara = path.join(permBase, `${linkId}.wara`);

            let finalPath = '';
            if (fs.existsSync(permWara)) {
                finalPath = permWara;
            } else if (fs.existsSync(tempWara)) {
                // SEALING: Move from temp to permanent
                console.log(`[Link] Sealing content ${linkId} (temp -> permanent)`);
                try {
                    const tempJson = path.join(tempBase, `${linkId}.json`);
                    const permJson = path.join(permBase, `${linkId}.json`);

                    if (fs.existsSync(tempWara)) fs.renameSync(tempWara, permWara);
                    if (fs.existsSync(tempJson)) fs.renameSync(tempJson, permJson);

                    // Also move any subtitles
                    const files = fs.readdirSync(tempBase);
                    files.forEach(f => {
                        if (f.startsWith(`${linkId}_`)) {
                            fs.renameSync(path.join(tempBase, f), path.join(permBase, f));
                        }
                    });

                    finalPath = permWara;
                } catch (err: any) {
                    console.error(`[Link] Sealing failed: ${err.message}`);
                    return res.status(500).json({ error: 'Failed to seal content files' });
                }
            } else {
                // Check legacy root for backward compatibility
                const legacyWara = path.join(CONFIG.DATA_DIR, `${linkId}.wara`);
                if (fs.existsSync(legacyWara)) {
                    finalPath = legacyWara;
                } else {
                    return res.status(404).json({ error: 'Physical content not found on node. Please upload first.' });
                }
            }

            // 2. Sovereign Media Registration (Universal Proposal Flow)
            if (node.blockchain.mediaRegistry) {
                let onChain = false;
                try {
                    const [exists] = await node.blockchain.mediaRegistry.exists(String(source), String(sourceId));
                    onChain = exists;
                } catch (e: any) {
                    console.warn(`[Web3] Registry check failed: ${e.message}`);
                }

                // If not on chain, ANY uploader registers it (Proposal/PendingDAO logic)
                if (!onChain) {
                    try {
                        console.log(`[Web3] Registering Media Identity on-chain for ${sourceId}...`);
                        const registryWrite = node.blockchain.mediaRegistry.connect(signer);

                        // Registering as a standard user creates a "Proposed" entry
                        // The smart contract logic handles the 'isOwner' check internally for status assignment
                        const tx = await (registryWrite as any).registerMedia(
                            String(media.source),
                            String(media.sourceId),
                            media.title,
                            media.waraId // Hash
                        );

                        console.log(`[Web3] Media Registration TX Sent: ${tx.hash}. Waiting for confirmation...`);
                        await tx.wait(); // CRITICAL: Wait for Media Identity to be mined before registering Link
                        console.log(`[Web3] Media Identity Confirmed.`);

                    } catch (e: any) {
                        console.warn(`[Web3] Media Registration failed: ${e.message}`);
                        // If media registration fails (e.g. reverted because someone else just did it), we might want to continue?
                        // But if it failed because of gas/network, Link registration will likely fail too. 
                        // We proceed cautiously.
                    }
                }
            }

            // 3. Link Creation
            const finalUploaderWallet = signer.address.toLowerCase();

            const existingLink = await node.prisma.link.findFirst({
                where: {
                    waraId: media.waraId,
                    uploaderWallet: finalUploaderWallet
                }
            });

            if (existingLink) {
                console.log(`[Link] Skipping duplicate link for ${media.title} by ${finalUploaderWallet}`);
                return res.json({ success: true, message: "Link already exists in your catalog", link: existingLink });
            }

            const newLink = await node.prisma.link.create({
                data: {
                    url,
                    title,
                    waraId: media.waraId,
                    source: String(source),
                    sourceId: String(sourceId),
                    mediaType: String(mediaType || 'movie'),
                    season: season ? parseInt(season as string) : undefined,
                    episode: episode ? parseInt(episode as string) : undefined,
                    uploaderWallet: finalUploaderWallet,
                    waraMetadata: waraMetadata ? (typeof waraMetadata === 'string' ? waraMetadata : JSON.stringify(waraMetadata)) : JSON.stringify({ source: "p2p-node-api", hoster: finalUploaderWallet })
                }
            });

            // 4. Automatic On-Chain Link Registration
            let txHash = null;
            let registrationError = null;

            try {
                const parsedMetadata = waraMetadata || { source: "p2p-node-api", hoster: finalUploaderWallet };
                const salt = parsedMetadata.salt || title || "default-salt";



                let contentHash = ethers.ZeroHash;
                if (parsedMetadata.hash && parsedMetadata.hash !== 'disabled') {
                    const rawHash = parsedMetadata.hash.startsWith('0x') ? parsedMetadata.hash : `0x${parsedMetadata.hash}`;
                    if (rawHash.length === 66 && /^0x[0-9a-fA-F]{64}$/.test(rawHash)) {
                        contentHash = rawHash;
                    }
                }

                const tx = await (node.blockchain.linkRegistry! as any).registerLink(contentHash, media.waraId, salt, finalUploaderWallet);
                txHash = tx.hash;
            } catch (err: any) {
                console.error("[Web3] Auto-Registration Failed:", err.message);
                registrationError = err.message;
            }

            res.json({
                success: true,
                link: newLink,
                txHash,
                registrationError,
                onChain: !!txHash
            });

            // 5. Activate in P2P Catalog (Memory)
            try {
                const mapPath = finalPath.replace('.wara', '.json');
                if (fs.existsSync(mapPath)) {
                    const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
                    node.catalog.registerLink(linkId, finalPath, mapData, mapData.key);
                }
            } catch (e) {
                console.warn(`[Link] Catalog activation failed for ${linkId}`);
            }

        } catch (e) {
            console.error("Link submission failed", e);
            res.status(500).json({ error: 'Failed to save link' });
        }
    });

    // --- ON-CHAIN REGISTRATION (The Human's Local Node acts as Signer) ---
    router.post('/register-on-chain', async (req: Request, res: Response) => {
        const { linkId, sourceId, source = 'tmdb', contentHash, salt, uploaderWallet } = req.body;

        const signer = node.identity.getAuthenticatedSigner(req);
        if (!signer) return res.status(401).json({ error: 'Authentication required to sign transactions.' });

        try {
            console.log(`[Web3] Local Signer requested for Link ${linkId || 'external'}...`);

            // Compute Media Hash if needed
            let finalMediaHash = ethers.ZeroHash;
            if (sourceId) {
                // Standardize IDs
                finalMediaHash = ethers.solidityPackedKeccak256(["string", "string"], [String(source), `:${String(sourceId)}`]);
            }

            // Check for required params
            if (!finalMediaHash || !contentHash) {
                // If params missing, try to recover from local DB
                const localLink = await node.prisma.link.findUnique({ where: { id: linkId } });
                if (!localLink) return res.status(400).json({ error: 'Missing registration parameters and link not found locally.' });

                const meta = JSON.parse(localLink.waraMetadata || '{}');

                // Content Hash
                let finalContentHash = ethers.ZeroHash;
                const rawHash = contentHash || meta.hash;
                if (rawHash && rawHash !== 'disabled') {
                    const normalized = rawHash.startsWith('0x') ? rawHash : `0x${rawHash}`;
                    if (normalized.length === 66 && /^0x[0-9a-fA-F]{64}$/.test(normalized)) {
                        finalContentHash = normalized;
                    }
                }

                // Media Hash (from stored Source ID)
                if (localLink.sourceId) {
                    finalMediaHash = ethers.solidityPackedKeccak256(["string", "string"], [localLink.source, `:${localLink.sourceId}`]);
                }

                const finalSalt = salt || meta.salt || localLink.title || "default-salt";
                const finalHoster = uploaderWallet || localLink.uploaderWallet || (signer ? signer.address : "");

                await performRegistration(finalMediaHash, finalContentHash, finalSalt, finalHoster);
                return;
            }

            // If we have all params in body
            await performRegistration(finalMediaHash, contentHash, salt, uploaderWallet || (signer ? signer.address : ""));
            return;

            async function performRegistration(mHash: string, cHash: string, s: string, hoster: string) {
                if (!signer) return res.status(401).json({ error: 'Signer disappeared' });
                const tx = await (node.blockchain.linkRegistry!.connect(signer) as any).registerLink(cHash, mHash, s, hoster);

                return res.json({ success: true, txHash: tx.hash });
            }

        } catch (e: any) {
            console.error("[Web3] Registration Error:", e);
            if (e.message && e.message.includes('insufficient funds')) {
                return res.status(402).json({ error: 'Insufficient funds for Gas', details: e.message });
            }
            res.status(500).json({ error: 'Registration failed', details: e.message });
        }
    });

    // --- DELETE LINK (from index) ---
    router.post('/delete', async (req: Request, res: Response) => {
        const { linkId } = req.body;
        if (!linkId) return res.status(400).json({ error: 'Missing linkId' });

        try {
            await node.prisma.link.delete({
                where: { id: linkId }
            });
            res.json({ success: true });
        } catch (e) {
            console.error("Link deletion from DB failed", e);
            res.status(500).json({ error: 'Failed to delete link' });
        }
    });

    //------------VOTES LINKS REPUTATION-------------//

    // POST /vote/signer (Sign & Relay to Remote Node)
    router.post('/vote/signer', async (req: Request, res: Response) => {
        const { linkId, contentHash, voteValue } = req.body;
        if (!linkId || !contentHash || !voteValue) {
            return res.status(400).json({ error: 'Missing params (need linkId, contentHash, voteValue)' });
        }

        try {

            // 1. Get authenticated signer from session (using authToken)
            const userSigner = node.identity.getAuthenticatedSigner(req);
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
                    ["bytes32", "bytes32", "int8", "address", "address", "uint256", "uint256", "uint256", "address"],
                    [onChainLinkId, hexContentHash, voteValue, voter, relayer, nonce, timestamp, Number((await node.blockchain.provider.getNetwork()).chainId), CONFIG.CONTRACTS.LINK_REGISTRY]
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
                            const peer = node.p2p.knownPeers.get(hostname);
                            if (peer) targetUrl = peer.endpoint;
                        }
                    } catch (e) { }
                }

                console.log(`[Vote] Upvote signed for Hoster: ${relayer}. Relaying to ${targetUrl}`);
                const response = await axios.post(`${targetUrl}/links/vote/submit`, {
                    linkId, contentHash, voteValue, voter, relayer, signature, nonce, timestamp
                });

                res.json({ success: true, relayedTo: targetUrl });

            } else {
                // DOWNVOTE: Sign for multiple peers to "repartir los votos" (Rewards for whoever submits)
                const peers = Array.from(node.p2p.knownPeers.values()).filter(p => p.walletAddress);
                const targets = peers.sort(() => 0.5 - Math.random()).slice(0, 5); // Random 5 peers

                if (targets.length === 0) {
                    // Fallback: Sign for our own node and submit locally
                    const relayer = node.identity.nodeSigner?.address || ethers.ZeroAddress;
                    const messageHash = ethers.solidityPackedKeccak256(
                        ["bytes32", "bytes32", "int8", "address", "address", "uint256", "uint256", "uint256", "address"],
                        [onChainLinkId, hexContentHash, voteValue, voter, relayer, nonce, timestamp, Number((await node.blockchain.provider.getNetwork()).chainId), CONFIG.CONTRACTS.LINK_REGISTRY]
                    );
                    const signature = await userSigner.signMessage(ethers.getBytes(messageHash));

                    console.log(`[Vote] No peers found for downvote. Relaying to self...`);
                    await axios.post(`http://localhost:${CONFIG.PORT}/links/vote/submit`, {
                        linkId, contentHash, voteValue, voter, relayer, signature, nonce, timestamp
                    });
                    res.json({ success: true, relayedTo: 'local' });
                } else {
                    console.log(`[Vote] Signing downvote for ${targets.length} peers...`);

                    const relays = await Promise.allSettled(targets.map(async (peer) => {
                        const relayer = peer.walletAddress;
                        const messageHash = ethers.solidityPackedKeccak256(
                            ["bytes32", "bytes32", "int8", "address", "address", "uint256", "uint256", "uint256", "address"],
                            [onChainLinkId, hexContentHash, voteValue, voter, relayer, nonce, timestamp, Number((await node.blockchain.provider.getNetwork()).chainId), CONFIG.CONTRACTS.LINK_REGISTRY]
                        );
                        const signature = await userSigner.signMessage(ethers.getBytes(messageHash));

                        return axios.post(`${peer.endpoint}/links/vote/submit`, {
                            linkId, contentHash, voteValue, voter, relayer, signature, nonce, timestamp
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

    // POST /vote/submit
    router.post('/vote/submit', async (req: Request, res: Response) => {
        const { linkId, contentHash, voteValue, voter, relayer, signature, nonce, timestamp } = req.body;
        if (!linkId || !contentHash || !voteValue || !voter || !signature || !relayer) return res.status(400).json({ error: 'Missing params' });

        try {
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
                ["bytes32", "bytes32", "int8", "address", "address", "uint256", "uint256", "uint256", "address"],
                [onChainLinkId, hexContentHash, voteValue, voter, relayer, nonce, timestamp, Number((await node.blockchain.provider.getNetwork()).chainId), CONFIG.CONTRACTS.LINK_REGISTRY]
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
            const votesDir = path.join(CONFIG.DATA_DIR, 'votes');
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

                const peers = Array.from(node.p2p.knownPeers.values());
                if (peers.length > 0) {
                    // Pick 3 random peers
                    const targets = peers.sort(() => 0.5 - Math.random()).slice(0, 3);

                    console.log(`[Vote] Gossiping downvote to ${targets.length} peers...`);

                    // Fire and forget - don't await
                    Promise.allSettled(targets.map(peer =>
                        axios.post(`${peer.endpoint}/links/vote/submit`, req.body)
                            .catch((err: any) => console.error(`Gossip failed to ${peer.endpoint}`, err.message))
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

    // GET /vote/received?wallet=0x... - Get votes received by this hoster (on their links)
    router.get('/vote/received', async (req: Request, res: Response) => {
        try {
            const { wallet } = req.query;
            const signer = node.identity.getAuthenticatedSigner(req);
            const targetWallet = (wallet as string || signer?.address || "").toLowerCase();

            if (!targetWallet) return res.status(400).json({ error: 'Missing wallet or session' });

            const fs = await import('fs');
            const path = await import('path');
            const votesDir = path.join(CONFIG.DATA_DIR, 'votes');
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

    // GET /vote/pending?wallet=0x... - Get votes I HAVE SENT that are on this node
    router.get('/vote/pending', async (req: Request, res: Response) => {
        try {
            const { wallet } = req.query;
            const signer = node.identity.getAuthenticatedSigner(req);
            const targetWallet = (wallet as string || signer?.address || "").toLowerCase();

            if (!targetWallet) return res.status(400).json({ error: 'Missing wallet or session' });

            const fs = await import('fs');
            const path = await import('path');
            const votesDir = path.join(CONFIG.DATA_DIR, 'votes');
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

    return router;
};