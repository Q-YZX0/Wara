import { Router, Request, Response } from 'express';
import { App } from '../App';
import { CONFIG } from '../config/config';
import { getMediaMetadata } from '../utils/tmdb';
import * as path from 'path';
import * as fs from 'fs';
import { ethers } from 'ethers';

export const setupMediaRoutes = (node: App) => {
    const router = Router();

    // Contrato en modo lectura (Singleton del nodo)
    const registry = node.blockchain.mediaRegistry!;

    // --- P2P Media Manifest Serving ---
    // GET /api/media/stream/:waraId
    // This allows other nodes to sync rich metadata (overview, posters) without TMDB
    router.get('/stream/:waraId', async (req: Request, res: Response) => {
        const { waraId } = req.params;
        if (!/^[a-z0-9_-]+$/i.test(waraId)) return res.status(400).end();

        try {
            const media = await node.prisma.media.findUnique({ where: { waraId } });
            if (!media || media.status === 'rejected') {
                return res.status(404).json({ error: "Media not found or rejected" });
            }
            res.json(media);
        } catch (e) {
            res.status(500).json({ error: "Internal error" });
        }
    });

    // POST /api/media/register 
    // - User: DAO Proposal
    router.post('/register', async (req: Request, res: Response) => {
        try {
            const { sourceId, source = 'tmdb', type = 'movie' } = req.body;
            if (!sourceId) return res.status(400).json({ error: "Missing sourceId" });

            // 0. Strict Identity Check (Must be an active USER session)
            const authToken = (req.headers['x-auth-token'] || req.body.authToken) as string;
            const signer = node.identity.activeWallets.get(authToken);
            if (!signer) return res.status(401).json({ error: "Unauthorized: Active USER session required" });

            // 0.1 Check Ownership Soberana (On-Chain Owner)
            let isContractOwner = false;
            try {
                const ownerAddress = await registry.owner();
                isContractOwner = (signer.address.toLowerCase() === ownerAddress.toLowerCase());
            } catch (e) {
                console.warn("[Media] Could not verify contract ownership, defaulting to Suggestion flow.");
            }

            // 0.2 Compute WaraID and check if already exists (Chain First)
            const waraId = ethers.solidityPackedKeccak256(["string", "string"], [String(source), `:${String(sourceId)}`]);
            let onChain = false;
            try {
                const [exists] = await registry.exists(String(source), String(sourceId));
                onChain = exists;
            } catch (e: any) {
                console.warn(`[Media] Registry check failed (Chain unreachable): ${e.message}`);
            }

            if (onChain && !isContractOwner) {
                try {
                    const mediaId = await registry.computeMediaId(String(source), String(sourceId));
                    return res.json({ success: true, message: "Media already registered on-chain", waraId: mediaId });
                } catch (e) {
                    return res.json({ success: true, message: "Media already registered on-chain", waraId });
                }
            }

            // 1. Enrich & Create Manifest (Both flows need this)
            const statusTarget = isContractOwner ? 'approved' : 'pending_dao';
            console.log(`[Media] Fetching and materializing metadata for ${sourceId} (${statusTarget})...`);

            // PASS SOURCE AND REQ.BODY (Extra Meta)
            const media = await getMediaMetadata(node.prisma, String(sourceId), String(type), statusTarget, node, String(source), req.body);
            if (!media) return res.status(404).json({ error: "Media not found in source" });

            // 2. Flow Decision
            if (isContractOwner) {
                if (onChain) return res.json({ success: true, message: "Admin: Already on-chain", media });

                // Admin Flow: Direct On-Chain using the authenticated signer
                const registryWrite = registry.connect(signer);

                console.log(`[Media] Admin Flow: Registering on-chain: ${media.title}`);
                const tx = await (registryWrite as any).registerMedia(
                    String(media.source),
                    String(media.sourceId),
                    media.title,
                    media.waraId // We use waraId as metadataHash correctly
                );
                await tx.wait();

                return res.json({ success: true, status: 'approved', txHash: tx.hash, media });
            } else {
                // User Flow: Proposal (Local DB + Manifest only)
                const signer = node.identity.getAuthenticatedSigner(req);
                if (!signer) return res.status(401).json({ error: "Unauthorized: Active session required for proposals" });

                if (media.status === 'approved') {
                    return res.json({ success: true, status: 'approved', message: "Media is already approved and registered", media });
                }

                // User Flow: Propose On-Chain
                const registryWrite = registry.connect(signer);
                console.log(`[Media] User Flow: Proposing on-chain: ${media.title}`);

                try {
                    const tx = await (registryWrite as any).proposeMedia(
                        String(media.source),
                        String(media.sourceId),
                        media.title,
                        media.waraId
                    );
                    await tx.wait();

                    return res.json({
                        success: true,
                        status: 'pending_dao',
                        message: "Media proposal submitted to DAO",
                        txHash: tx.hash,
                        media
                    });
                } catch (err: any) {
                    // Start of Proposal failed (maybe already proposed or no WARA)
                    return res.status(400).json({ error: "Proposal failed: " + err.message });
                }
            }

        } catch (e: any) {
            console.error(e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/media/config
    // Returns contract address and owner for UI adaptation
    // Creo que esta funcion no tiene sentido podria estar legacy (verificar)
    router.get('/config', async (req: Request, res: Response) => {
        try {
            const owner = await registry.owner();
            res.json({
                registryAddress: await registry.getAddress(),
                ownerAddress: owner
            });
        } catch (e) {
            res.status(500).json({ error: "Failed to fetch registry config" });
        }
    });

    // GET /api/media/lookup?sourceId=550&source=tmdb
    // Busca si una película existe en el registro oficial
    router.get('/lookup', async (req: Request, res: Response) => {
        try {
            const { sourceId, source = 'tmdb' } = req.query;
            if (!sourceId) return res.status(400).json({ error: "Missing sourceId" });

            // exists(source, externalId) -> returns [bool exists, bytes32 id]
            const [found, mediaId] = await registry.exists(String(source), String(sourceId));

            if (!found) return res.json({ found: false });

            const media = await registry.getMedia(mediaId);

            res.json({
                found: true,
                mediaId: media.id,
                title: media.title,
                metadataHash: media.metadataHash,
                active: media.active
            });

        } catch (e: any) {
            console.error("[Media] Lookup error:", e);
            res.json({ found: false, error: "Not registered in blockchain" });
        }
    });

    // GET /api/media/proposals
    // Obtiene las propuestas de contenido
    router.get('/proposals', node.identity.requireAuth, async (req: Request, res: Response) => {
        try {
            const status = req.query.status as string || 'pending_dao';
            const proposals = await node.prisma.media.findMany({
                where: { status: status },
                orderBy: { createdAt: 'desc' }
            });
            res.json(proposals);
        } catch (e) {
            res.status(500).json({ error: "Failed to fetch proposals" });
        }
    });

    // --- GOVERNANCE (Content Curation) ---

    // GET /api/media/status/:waraId
    router.get('/status/:waraId', async (req: Request, res: Response) => {
        try {
            const { waraId } = req.params;

            // 1. Get Local Media (For metadata)
            const media = await node.prisma.media.findUnique({ where: { waraId } });
            if (!media) return res.status(404).json({ error: "Media not found locally" });

            // CRITICAL FIX: If already approved locally, trust it. 
            // This prevents zombie proposals (unresolved on-chain) from overriding the approved status in UI.
            if (media.status === 'approved') {
                return res.json({
                    waraId,
                    status: 'approved',
                    onChain: true,
                    votes: { up: 0, down: 0, total: 0 },
                    period: { isOpen: false, remainingHours: 0 }
                });
            }

            // 2. Query On-Chain Proposal (Only if not locally approved)
            // Check if active (registered)
            const mediaData = await registry.getMedia(waraId).catch(() => null);
            if (mediaData && mediaData.id !== ethers.ZeroHash) {
                return res.json({
                    waraId,
                    status: 'approved',
                    onChain: true,
                    votes: { up: 0, down: 0, total: 0 }, // It's done
                    period: { isOpen: false, remainingHours: 0 }
                });
            }

            // Check Proposal
            const proposal = await registry.proposals(waraId).catch(() => null);

            if (!proposal || proposal.deadline === 0) {
                return res.json({
                    waraId,
                    status: media.status, // likely 'pending_dao' locally but not on chain yet?
                    onChain: false,
                    votes: { up: 0, down: 0, total: 0 },
                    period: { isOpen: false, remainingHours: 0 }
                });
            }

            const now = Math.floor(Date.now() / 1000);
            const deadline = Number(proposal.deadline);
            const remaining = Math.max(0, deadline - now);

            res.json({
                waraId: media.waraId,
                status: 'pending_dao',
                onChain: true,
                votes: {
                    up: Number(proposal.upvotes),
                    down: Number(proposal.downvotes),
                    total: Number(proposal.upvotes) + Number(proposal.downvotes)
                },
                period: {
                    start: deadline - (3 * 24 * 3600),
                    end: deadline * 1000,
                    remainingHours: (remaining / 3600).toFixed(1),
                    isOpen: remaining > 0 && !proposal.executed
                },
                executed: proposal.executed
            });

        } catch (e: any) {
            console.error("[Governance] Status Error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/media/review
    // Aprueba o rechaza una propuesta. Si rechaza, borra el manifiesto.
    router.post('/review', node.identity.requireAuth, async (req: Request, res: Response) => {
        const { waraId, status } = req.body;
        if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: "Invalid status" });

        try {
            const fs = require('fs');
            const path = require('path');

            const media = await node.prisma.media.update({
                where: { waraId },
                data: { status }
            });

            if (status === 'rejected') {
                const manifestPath = path.join(CONFIG.DATA_DIR, 'media', `${waraId}.json`);
                if (fs.existsSync(manifestPath)) {
                    fs.unlinkSync(manifestPath);
                    console.log(`[Media] Burned Sovereign Manifest for rejected media: ${waraId}`);
                }
                // Optional: We could also update associated links to be inactive, but the user asked about "ese archivo"
            }

            res.json({ success: true, status: media.status });
        } catch (e: any) {
            console.error("[Media] Review Error:", e);
            res.status(500).json({ error: "Review failed", details: e.message });
        }
    });

    // POST /api/media/vote
    router.post('/vote', async (req: Request, res: Response) => {
        try {
            const { side, source, sourceId } = req.body;
            const authToken = req.headers['x-auth-token'] as string;
            if (!authToken) return res.status(401).json({ error: "Auth required" });

            const wallet = node.identity.activeWallets.get(authToken);
            if (!wallet) return res.status(401).json({ error: "Session invalid" });

            const userSigner = wallet.connect(node.blockchain.provider);
            const registryWrite = node.blockchain.mediaRegistry!.connect(userSigner) as ethers.Contract;

            console.log(`[Governance] Voting ${side} on ${source}:${sourceId} by ${userSigner.address}...`);
            const tx = await registryWrite.vote(source, sourceId, side);
            await tx.wait();

            res.json({ success: true, txHash: tx.hash, message: "Vote cast on-chain" });
        } catch (e: any) {
            console.error("[Governance] Vote Error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/media/resolve
    router.post('/resolve', async (req: Request, res: Response) => {
        try {
            const { source, sourceId, title } = req.body;
            const authToken = req.headers['x-auth-token'] as string;
            if (!authToken) return res.status(401).json({ error: "Auth required" });

            const wallet = node.identity.activeWallets.get(authToken);
            if (!wallet) return res.status(401).json({ error: "Session invalid" });

            const userSigner = wallet.connect(node.blockchain.provider);
            const registryWrite = node.blockchain.mediaRegistry!.connect(userSigner) as ethers.Contract;

            console.log(`[Governance] Resolving ${source}:${sourceId} by ${userSigner.address}...`);
            const tx = await registryWrite.resolveProposal(source, sourceId, title, "meta_hash_placeholder");
            await tx.wait();

            res.json({ success: true, txHash: tx.hash, message: "Proposal Resolved" });
        } catch (e: any) {
            console.error("[Governance] Resolve Error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
