import { Router } from 'express';
import { App } from '../App';

export const setupLeaderboardRoutes = (node: App) => {
    const router = Router();
    // GET /api/leaderboard/content - Top Ranked Links
    router.get('/content', async (req, res) => {
        try {
            // Fetch top 50 links by trust score
            const links = await node.prisma.link.findMany({
                orderBy: { trustScore: 'desc' },
                take: 50,
                where: { trustScore: { gt: 0 } } // Only show positive rep links
            });

            // Enrich with Media Title 
            const enrichedLinks = await Promise.all(links.map(async (l) => {
                const media = await node.prisma.media.findUnique({
                    where: { waraId: l.waraId },
                    select: { title: true, type: true }
                });

                return {
                    id: l.id,
                    title: media?.title || l.title || "Unknown Title",
                    mediaType: media?.type || l.mediaType || 'movie',
                    sourceId: l.sourceId,
                    source: l.source,
                    season: l.season,
                    episode: l.episode,
                    uploader: l.uploaderWallet,
                    trustScore: l.trustScore,
                    upvotes: l.upvotes,
                    downvotes: l.downvotes
                };
            }));

            res.json({ content: enrichedLinks });
        } catch (e) {
            console.error("Leaderboard Content Error:", e);
            res.status(500).json({ error: "Failed to fetch leaderboard" });
        }
    });

    // GET /api/leaderboard/users - Top Ranked Users
    router.get('/users', async (req, res) => {
        try {
            const users = await node.prisma.user.findMany({
                where: { walletAddress: { not: null } },
                select: { id: true, email: true, walletAddress: true, pendingRewards: true }
            });

            // If we need real ERC20 balances, we can query node.blockchain.provider here
            // For now, we simulate WARA balance with pendingRewards or simple mapping
            const leaderboard = users.map(u => {
                const simulatedRep = (u.pendingRewards || 0) * 10 + 100;
                return {
                    name: u.walletAddress ? `${u.walletAddress.slice(0, 6)}...` : 'Anonymous',
                    address: u.walletAddress!,
                    reputation: simulatedRep,
                    // Simple placeholder, real WARA balance can be fetched via contract if added to BlockchainService
                    balance: simulatedRep 
                };
            });

            leaderboard.sort((a, b) => b.balance - a.balance);

            res.json({ users: leaderboard });
        } catch (e) {
            console.error("Leaderboard Users Error:", e);
            res.status(500).json({ error: "Failed to fetch users leaderboard" });
        }
    });

    return router;
};