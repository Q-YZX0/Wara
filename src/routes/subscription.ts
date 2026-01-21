import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { WaraNode } from '../node';
import { WARA_TOKEN_ADDRESS, ERC20_ABI } from '../contracts';

export const setupSubscriptionRoutes = (node: WaraNode) => {
    const router = Router();

    // Contract instance for READ operations (reuses node's instance)
    const readContract = node.subContract;

    // GET /api/subscription/stats
    router.get('/stats', async (req: Request, res: Response) => {
        try {
            // Returns: totalSubscribers, totalRevenue, hosterPoolBalance, totalPremiumViews, currentPriceWARA
            const stats = await readContract.getStats();

            res.json({
                totalSubscribers: Number(stats[0]),
                totalRevenue: stats[1].toString(),
                hosterPoolBalance: stats[2].toString(),
                totalPremiumViews: Number(stats[3]),
                price: stats[4].toString(), // Send Raw Wei String
                currentPriceWARA: stats[4].toString() // Alias for frontend
            });
        } catch (error: any) {
            console.error('Stats error:', error);
            // Fallback for older contracts or errors
            try {
                const price = await readContract.getCurrentPrice();
                res.json({
                    price: price.toString(),
                    totalSubscribers: 0
                });
            } catch (e) {
                res.status(500).json({ error: error.message });
            }
        }
    });

    // GET /api/subscription/status?wallet=ADDR
    router.get('/status', async (req: Request, res: Response) => {
        try {
            const wallet = req.query.wallet as string;
            if (!wallet) return res.status(400).json({ error: "Missing wallet" });

            const isSubscribed = await readContract.isSubscribed(wallet);

            let details = null;
            try {
                // Returns: [active, expiresAt, daysRemaining, totalPaid, subscriptionCount]
                const sub = await readContract.getSubscription(wallet);

                details = {
                    expiresAt: Number(sub[1]), // expiresAt
                    daysRemaining: Number(sub[2]), // daysRemaining from contract
                    totalPaid: sub[3].toString() // totalPaid (Wei string)
                };
            } catch (e) {
                console.log(`[Subscription] Failed to load details for ${wallet}:`, e);
            }

            res.json({ isSubscribed, details });
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    });

    // POST /api/subscription/subscribe
    router.post('/subscribe', async (req: Request, res: Response) => {
        try {
            const authToken = req.headers['x-wara-token'] as string;

            let userSigner: any = null;
            if (authToken && node.activeWallets.has(authToken)) {
                userSigner = node.activeWallets.get(authToken);
            }

            if (!userSigner) {
                return res.status(401).json({ error: "No active wallet session found. Please login." });
            }

            // Explicitly verify provider
            if (!node.provider) {
                throw new Error("Node provider is not initialized");
            }

            // Connect signer to provider explicitly
            const connectedSigner = userSigner.connect(node.provider);
            console.log(`[Subscription] Processing for ${connectedSigner.address}`);

            // Instantiate Contracts
            // 1. Token Contract (Write access needed for approve)
            const tokenContract = new ethers.Contract(WARA_TOKEN_ADDRESS, ERC20_ABI, connectedSigner);

            // 2. Subscription Contract (Write access needed for subscribe)
            const subContract = node.subContract.connect(connectedSigner) as ethers.Contract;

            // READ operation using the PROVIDER (safer for "call")
            const readToken = new ethers.Contract(WARA_TOKEN_ADDRESS, ERC20_ABI, node.provider);

            console.log(`[Subscription] Checking price...`);
            const price = await readContract.getCurrentPrice();

            console.log(`[Subscription] Checking allowance...`);
            const allowance = await readToken.allowance(connectedSigner.address, await node.subContract.getAddress());

            if (allowance < price) {
                console.log(`[Subscription] Approving WARA...`);
                // WRITE operation using the SIGNER
                const txApprove = await tokenContract.approve(await node.subContract.getAddress(), ethers.MaxUint256);
                await txApprove.wait();
                console.log(`[Subscription] Approved: ${txApprove.hash}`);
            }

            console.log(`[Subscription] Subscribing...`);
            // WRITE operation using the SIGNER
            const tx = await subContract.subscribe();
            await tx.wait();

            console.log(`[Subscription] Success: ${tx.hash}`);
            res.json({ success: true, txHash: tx.hash });

        } catch (error: any) {
            console.error('Subscribe error:', error);
            res.status(500).json({ error: error.message || error.reason || "Subscription failed" });
        }
    });

    return router;
};
