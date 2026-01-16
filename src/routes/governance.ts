import { Router, Express, Request, Response } from 'express';
import { WaraNode } from '../node';
import { ethers } from 'ethers';
import { MEDIA_REGISTRY_ADDRESS, MEDIA_REGISTRY_ABI } from '../contracts';

export const setupGovernanceRoutes = (app: Express, node: WaraNode) => {
    const router = Router();

    // GET /status/:waraId
    router.get('/status/:waraId', async (req: Request, res: Response) => {
        try {
            const { waraId } = req.params;

            // 1. Get Local Media (For metadata)
            const media = await node.prisma.media.findUnique({ where: { waraId } });
            if (!media) return res.status(404).json({ error: "Media not found locally" });

            // 2. Query On-Chain Proposal
            const registry = new ethers.Contract(MEDIA_REGISTRY_ADDRESS, MEDIA_REGISTRY_ABI, node.provider);

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

    // POST /propose
    router.post('/propose', async (req: Request, res: Response) => {
        try {
            const { source, sourceId, title, waraId } = req.body;
            const authToken = req.headers['x-auth-token'] as string;
            if (!authToken) return res.status(401).json({ error: "Auth required" });

            const wallet = node.activeWallets.get(authToken);
            if (!wallet) return res.status(401).json({ error: "Session invalid or wallet missing" });

            const userSigner = wallet.connect(node.provider);
            const registry = new ethers.Contract(MEDIA_REGISTRY_ADDRESS, MEDIA_REGISTRY_ABI, userSigner);

            console.log(`[Governance] Proposing ${title} by ${userSigner.address}...`);
            const tx = await registry.proposeMedia(source, sourceId, title, "meta_hash_placeholder");
            await tx.wait();

            res.json({ success: true, txHash: tx.hash, message: "Proposal created on-chain" });
        } catch (e: any) {
            console.error("[Governance] Propose Error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /vote
    router.post('/vote', async (req: Request, res: Response) => {
        try {
            const { waraId, side, source, sourceId } = req.body;
            const authToken = req.headers['x-auth-token'] as string;
            if (!authToken) return res.status(401).json({ error: "Auth required" });

            const wallet = node.activeWallets.get(authToken);
            if (!wallet) return res.status(401).json({ error: "Session invalid" });

            const userSigner = wallet.connect(node.provider);
            const registry = new ethers.Contract(MEDIA_REGISTRY_ADDRESS, MEDIA_REGISTRY_ABI, userSigner);

            console.log(`[Governance] Voting ${side} on ${source}:${sourceId} by ${userSigner.address}...`);
            const tx = await registry.vote(source, sourceId, side);
            await tx.wait();

            res.json({ success: true, txHash: tx.hash, message: "Vote cast on-chain" });
        } catch (e: any) {
            console.error("[Governance] Vote Error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /resolve
    router.post('/resolve', async (req: Request, res: Response) => {
        try {
            const { source, sourceId, title } = req.body;
            const authToken = req.headers['x-auth-token'] as string;
            if (!authToken) return res.status(401).json({ error: "Auth required" });

            const wallet = node.activeWallets.get(authToken);
            if (!wallet) return res.status(401).json({ error: "Session invalid" });

            const userSigner = wallet.connect(node.provider);
            const registry = new ethers.Contract(MEDIA_REGISTRY_ADDRESS, MEDIA_REGISTRY_ABI, userSigner);

            console.log(`[Governance] Resolving ${source}:${sourceId} by ${userSigner.address}...`);
            const tx = await registry.resolveProposal(source, sourceId, title, "meta_hash_placeholder");
            await tx.wait();

            res.json({ success: true, txHash: tx.hash, message: "Proposal Resolved" });
        } catch (e: any) {
            console.error("[Governance] Resolve Error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    app.use('/api/governance', router);
};
