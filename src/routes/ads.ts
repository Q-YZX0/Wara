import { Router, Request, Response } from 'express';
import { App } from '../App';
import { ethers } from 'ethers';


export const setupAdsRoutes = (node: App) => {
    const router = Router();
    const contract = node.blockchain.adManager!;
    const tokenContract = node.blockchain.token!;
    // GET /api/ads/my-campaigns?wallet=0x...
    router.get('/my-campaigns', async (req: Request, res: Response) => {
        const wallet = req.query.wallet as string;
        if (!wallet) return res.json([]);

        try {
            const campaignsRaw = await contract.getCampaignsByAdvertiser(wallet);

            const campaigns = campaignsRaw.map((item: any) => {
                const c = item.campaign || item[1];
                return {
                    id: Number(item.id || item[0]),
                    campaign: {
                        advertiser: c.advertiser || c[0],
                        budgetWARA: ethers.formatUnits(c.budgetWARA ?? c[1] ?? "0", 18),
                        duration: Number(c.duration ?? c[2]),
                        videoHash: c.videoHash || c[3],
                        viewsRemaining: Number(c.viewsRemaining ?? c[4]),
                        category: Number(c.category ?? c[5]),
                        active: c.active ?? c[6]
                    }
                };
            });
            res.json(campaigns.reverse());
        } catch (e: any) {
            console.error("Fetch campaigns failed", e);
            res.status(500).json({ error: "Failed to fetch campaigns" });
        }
    });

    // GET /api/ads/cost?duration=15
    router.get('/cost', async (req: Request, res: Response) => {
        try {
            const duration = Number(req.query.duration || 15);

            const cost = await contract.getCurrentCostPerView(duration);
            res.json({ cost: ethers.formatUnits(cost, 18) });
        } catch (e: any) {
            console.error("[Ads] Failed to get cost:", e.message || e);
            res.status(500).json({ error: "Failed to get cost", details: e.message });
        }
    });

    // POST /api/ads/create
    router.post('/create', async (req: Request, res: Response) => {
        const { wallet, budget, duration, videoHash, category } = req.body;
        if (!wallet || !budget || !videoHash) return res.status(400).json({ error: "Missing params" });

        try {
            const userSigner = await node.identity.getLocalUserWallet(wallet); // Using node instance

            const token = tokenContract.connect(userSigner) as ethers.Contract;
            const manager = contract.connect(userSigner) as ethers.Contract;

            const budgetWei = ethers.parseUnits(budget.toString(), 18);

            console.log(`[Ads] Approving ${budget} WARA for ${wallet}...`);
            const txApprove = await token.approve(await contract.getAddress(), budgetWei);
            await txApprove.wait();

            console.log(`[Ads] Creating Campaign for ${videoHash}...`);
            const txCreate = await manager.createCampaign(budgetWei, duration, videoHash, category || 0);
            const receipt = await txCreate.wait();

            console.log(`[Ads] Campaign Created! TX: ${receipt.hash}`);
            res.json({ success: true, txHash: receipt.hash });

        } catch (e: any) {
            console.error("Create Campaign failed", e);
            res.status(500).json({ error: e.message || "Failed to create campaign" });
        }
    });

    // POST /api/ads/cancel
    router.post('/cancel', async (req: Request, res: Response) => {
        const { wallet, id } = req.body;
        try {
            const userSigner = await node.identity.getLocalUserWallet(wallet); // Using node instance
            const manager = contract.connect(userSigner) as ethers.Contract;

            const tx = await manager.cancelCampaign(id);
            await tx.wait();
            res.json({ success: true, txHash: tx.hash });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/ads/toggle-pause
    router.post('/toggle-pause', async (req: Request, res: Response) => {
        const { wallet, id } = req.body;
        try {
            const userSigner = await node.identity.getLocalUserWallet(wallet); // Using node instance
            const manager = contract.connect(userSigner) as ethers.Contract;

            const tx = await manager.togglePause(id);
            await tx.wait();
            res.json({ success: true, txHash: tx.hash });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/ads/report
    router.post('/report', async (req: Request, res: Response) => {
        const { wallet, id, reason } = req.body;
        try {
            const userSigner = await node.identity.getLocalUserWallet(wallet); // Using node instance
            const manager = contract.connect(userSigner) as ethers.Contract;

            console.log(`[Ads] Reporting Ad #${id} by ${wallet}, Reason: ${reason}`);
            const tx = await manager.reportAd(id, reason);
            await tx.wait();

            res.json({ success: true, txHash: tx.hash });
        } catch (e: any) {
            console.error("Report Failed:", e);
            res.status(500).json({ error: e.message || "Failed to report ad" });
        }
    });

    // POST /api/ads/topup
    router.post('/topup', async (req: Request, res: Response) => {
        const { wallet, id, amount } = req.body;
        try {
            const userSigner = await node.identity.getLocalUserWallet(wallet); // Using node instance

            const token = tokenContract.connect(userSigner) as ethers.Contract;
            const manager = contract.connect(userSigner) as ethers.Contract;

            const amountWei = ethers.parseUnits(amount.toString(), 18);

            // Approve
            const txApprove = await token.approve(await contract.getAddress(), amountWei);
            await txApprove.wait();

            // Deposit
            const tx = await manager.topUpCampaign(id, amountWei);
            await tx.wait();
            res.json({ success: true, txHash: tx.hash });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
