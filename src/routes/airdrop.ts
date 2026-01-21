import { Router, Request, Response } from 'express';
import { WaraNode } from '../node';
import fs from 'fs';
import path from 'path';

export const setupAirdropRoutes = (node: WaraNode) => {
    const router = Router();
    const contract = node.airdropContract;
    // GET /state
    router.get('/state', async (req: Request, res: Response) => {
        try {
            const currentCycleId = await contract.currentCycleId();
            const totalRegistered = await contract.totalRegistered();
            const lastCycleTime = await contract.lastCycleTime();

            let userRegistered = false;
            let userClaimed = false;

            const userSigner = node.getAuthenticatedSigner(req);
            if (userSigner) {
                userRegistered = await contract.isRegistered(userSigner.address);
                if (currentCycleId > 0) {
                    userClaimed = await contract.hasClaimed(currentCycleId, userSigner.address);
                }
            }

            res.json({
                currentCycleId: Number(currentCycleId),
                totalRegistered: Number(totalRegistered),
                lastCycleTime: Number(lastCycleTime),
                userRegistered,
                userClaimed,
                airdropActive: currentCycleId > 0
            });
        } catch (e: any) {
            console.error("[Airdrop] State query failed:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/airdrop/register
    router.post('/register', async (req: Request, res: Response) => {
        try {
            const userSigner = node.getAuthenticatedSigner(req);
            if (!userSigner) return res.status(401).json({ error: 'Unauthorized' });

            const connectedSigner = userSigner.connect(node.provider);
            const contractWithUser = contract.connect(connectedSigner) as any;

            console.log(`[Airdrop] Registering user: ${userSigner.address}`);
            const tx = await contractWithUser.register();
            await tx.wait();

            res.json({ success: true, txHash: tx.hash });
        } catch (e: any) {
            console.error("[Airdrop] Registration failed:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/airdrop/claim
    router.post('/claim', async (req: Request, res: Response) => {
        let { cycleId, amount, merkleProof } = req.body;

        try {
            const userSigner = node.getAuthenticatedSigner(req);

            // AUTO-PROOF LOOKUP
            if (userSigner && (!merkleProof || merkleProof.length === 0)) {

                const airdropDir = path.join(node.dataDir, 'airdrops');

                if (fs.existsSync(airdropDir)) {
                    const files = fs.readdirSync(airdropDir);
                    for (const file of files) {
                        try {
                            if (!file.endsWith('.json')) continue;
                            const data = JSON.parse(fs.readFileSync(path.join(airdropDir, file), 'utf-8'));
                            // Match cycle or just use recent
                            const claimData = data.claims[userSigner.address.toLowerCase()] || data.claims[userSigner.address];
                            if (claimData) {
                                console.log(`[Airdrop] Found Auto-Proof for ${userSigner.address}`);
                                merkleProof = claimData.proof;
                                amount = claimData.amount;
                            }
                        } catch (e) { }
                    }
                }
            }
            if (!userSigner) return res.status(401).json({ error: 'Unauthorized' });

            const connectedSigner = userSigner.connect(node.provider);
            const contractWithUser = contract.connect(connectedSigner) as any;

            console.log(`[Airdrop] Claiming for user: ${userSigner.address}, Cycle: ${cycleId}`);
            const tx = await contractWithUser.claim(cycleId, amount, merkleProof);
            await tx.wait();

            res.json({ success: true, txHash: tx.hash });
        } catch (e: any) {
            console.error("[Airdrop] Claim failed:", e);
            res.status(500).json({ error: e.message });
        }
    });
    return router;
};
