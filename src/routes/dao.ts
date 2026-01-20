import { Router, Request, Response } from 'express';
import { WaraNode } from '../node';

export const setupDaoRoutes = (node: WaraNode) => {
    const router = Router();
    // GET /api/dao/proposals
    router.get('/proposals', async (req: Request, res: Response) => {
        try {
            const nextId = await node.daoContract.nextProposalId();
            const proposals = [];

            // Fetch last 10 proposals
            const start = Number(nextId) > 10 ? Number(nextId) - 10 : 0;
            for (let i = Number(nextId) - 1; i >= start; i--) {
                if (i < 0) break;
                const p = await node.daoContract.proposals(i);
                proposals.push({
                    id: Number(p.id),
                    description: p.description,
                    recipient: p.recipient,
                    amount: p.amount.toString(),
                    pType: Number(p.pType),
                    upvotes: p.upvotes.toString(),
                    downvotes: p.downvotes.toString(),
                    deadline: Number(p.deadline),
                    executed: p.executed,
                    approved: p.approved
                });
            }

            res.json(proposals);
        } catch (e: any) {
            console.error("[DAO] Fetch failed:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/dao/proposals
    router.post('/proposals', async (req: Request, res: Response) => {
        const { description, recipient, amount, pType } = req.body;
        try {
            const userSigner = node.getAuthenticatedSigner(req);
            if (!userSigner) return res.status(401).json({ error: 'Unauthorized' });

            const connectedSigner = userSigner.connect(node.provider);
            const contractWithUser = node.daoContract.connect(connectedSigner) as any;

            const tx = await contractWithUser.createProposal(description, recipient, amount, pType);
            await tx.wait();

            res.json({ success: true, txHash: tx.hash });
        } catch (e: any) {
            console.error("[DAO] Creation failed:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/dao/vote
    router.post('/vote', async (req: Request, res: Response) => {
        const { proposalId, side } = req.body;
        try {
            const userSigner = node.getAuthenticatedSigner(req);
            if (!userSigner) return res.status(401).json({ error: 'Unauthorized' });

            const connectedSigner = userSigner.connect(node.provider);
            const contractWithUser = node.daoContract.connect(connectedSigner) as any;

            const tx = await contractWithUser.vote(proposalId, side);
            await tx.wait();

            res.json({ success: true, txHash: tx.hash });
        } catch (e: any) {
            console.error("[DAO] Vote failed:", e);
            res.status(500).json({ error: e.message });
        }
    });
    return router;
};
