import { Express, Request, Response } from 'express';
import { ethers } from 'ethers';
import { WaraNode } from '../node';
import { getMediaMetadata } from '../tmdb';
import path from 'path';
import fs from 'fs';

export const setupLinkRoutes = (app: Express, node: WaraNode) => {
    // Get filtered links
    app.get('/api/links', async (req: Request, res: Response) => {
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
                    const url = new URL(link.url);
                    const hostname = url.hostname;
                    const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname === 'localhost';

                    if (isIpAddress) {
                        // If it's an IP, check if it's our own public IP (NAT Loopback fix)
                        // ONLY replace with localhost if the requester is also local
                        if (hostname === node.publicIp && isLocalRequest) {
                            resolvedUrl = link.url.replace(`${url.protocol}//${url.host}`, `http://localhost:${node.port}`);
                        }
                    } else {
                        // Hostname is nodeName or nodeAddress, need to resolve
                        const identifier = hostname;
                        const nodeAny = node as any;

                        // Check if it's the local node
                        const isLocalByName = identifier.includes('.wara') && nodeAny.nodeName && identifier === nodeAny.nodeName;
                        const isLocalByAddress = identifier.startsWith('0x') && nodeAny.nodeAddress && nodeAny.nodeAddress.toLowerCase() === identifier.toLowerCase();

                        if (isLocalByName || isLocalByAddress) {
                            // Local link -> use localhost OR Public IP depending on requester
                            const targetBase = isLocalRequest ? `localhost:${node.port}` : `${node.publicIp}:${node.port}`;
                            resolvedUrl = link.url.replace(`${url.protocol}//${url.host}`, `http://${targetBase}`);
                        } else {
                            // Remote link -> resolve to IP (for frontend to fetch)
                            // Search in knownPeers first
                            for (const [peerName, peer] of node.knownPeers.entries()) {
                                const matchByName = identifier.includes('.wara') && peerName === identifier;
                                const matchByAddress = identifier.startsWith('0x') && peer.nodeAddress && peer.nodeAddress.toLowerCase() === identifier.toLowerCase();

                                if (matchByName || matchByAddress) {
                                    resolvedUrl = link.url.replace(`${url.protocol}//${url.host}`, peer.endpoint);
                                    break;
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Invalid URL, keep as-is
                }

                return { ...link, url: resolvedUrl };
            }));

            res.json(resolvedLinks);
        } catch (e) {
            res.status(500).json({ error: 'Failed to fetch links' });
        }
    });

    // Create new link (Authenticated & Robust)
    app.post('/api/links', async (req: Request, res: Response) => {
        const { sourceId, source = 'tmdb', mediaType, url, title, waraMetadata, season, episode } = req.body;

        if (!sourceId || !url || !title) return res.status(400).json({ error: 'Missing fields' });

        // 0. Strict Identity Check (Must be an active USER session)
        const authToken = (req.headers['x-auth-token'] || req.body.authToken) as string;
        const signer = node.activeWallets.get(authToken);
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
            if (node.mediaRegistry) {
                try {
                    const ownerAddress = await node.mediaRegistry.owner();
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

            const tempBase = path.join(node.dataDir, 'temp');
            const permBase = path.join(node.dataDir, 'permanent');
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
                const legacyWara = path.join(node.dataDir, `${linkId}.wara`);
                if (fs.existsSync(legacyWara)) {
                    finalPath = legacyWara;
                } else {
                    return res.status(404).json({ error: 'Physical content not found on node. Please upload first.' });
                }
            }

            // 2. Sovereign Media Registration (Lazy Flow)
            if (node.mediaRegistry) {
                let onChain = false;
                try {
                    const [exists] = await node.mediaRegistry.exists(String(source), String(sourceId));
                    onChain = exists;
                } catch (e: any) {
                    console.warn(`[Web3] Registry check failed: ${e.message}`);
                }

                if (!onChain && isContractOwner) {
                    try {
                        console.log(`[Web3] Blessing: Content ${sourceId} officially registered by Owner.`);
                        const registryWrite = node.mediaRegistry.connect(signer);
                        const tx = await (registryWrite as any).registerMedia(
                            String(media.source),
                            String(media.sourceId),
                            media.title,
                            media.waraId // Hash
                        );
                        await tx.wait();
                    } catch (e: any) {
                        console.warn(`[Web3] Blessing failed: ${e.message}`);
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

                const { ethers } = await import('ethers');
                const { LINK_REGISTRY_ADDRESS, LINK_REGISTRY_ABI } = await import('../contracts');

                let contentHash = ethers.ZeroHash;
                if (parsedMetadata.hash && parsedMetadata.hash !== 'disabled') {
                    const rawHash = parsedMetadata.hash.startsWith('0x') ? parsedMetadata.hash : `0x${parsedMetadata.hash}`;
                    if (rawHash.length === 66 && /^0x[0-9a-fA-F]{64}$/.test(rawHash)) {
                        contentHash = rawHash;
                    }
                }

                const activeSigner = signer.provider ? signer : signer.connect(node.provider);
                const reputation = new ethers.Contract(LINK_REGISTRY_ADDRESS, LINK_REGISTRY_ABI, activeSigner);

                const tx = await reputation.registerLink(contentHash, media.waraId, salt, finalUploaderWallet);
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
                    node.registerLink(linkId, finalPath, mapData, mapData.key);
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
    app.post('/api/links/register-on-chain', async (req: Request, res: Response) => {
        const { linkId, sourceId, source = 'tmdb', contentHash, salt, uploaderWallet } = req.body;

        const signer = node.getAuthenticatedSigner(req);
        if (!signer) return res.status(401).json({ error: 'Authentication required to sign transactions.' });

        try {
            const { ethers } = await import('ethers');
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
                const { ethers } = await import('ethers');
                const { LINK_REGISTRY_ADDRESS, LINK_REGISTRY_ABI } = await import('../contracts');

                if (!signer) return res.status(401).json({ error: 'Signer disappeared' });
                const activeSigner = signer.provider ? signer : signer.connect(node.provider);
                const reputation = new ethers.Contract(LINK_REGISTRY_ADDRESS, LINK_REGISTRY_ABI, activeSigner);

                console.log(`[Web3] Sending registerLink TX. Hoster: ${hoster}, MediaHash: ${mHash}`);
                // registerLink(contentHash, mediaHash, salt, hoster)
                const tx = await reputation.registerLink(cHash, mHash, s, hoster);

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
    app.post('/api/links/delete', async (req: Request, res: Response) => {
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
};