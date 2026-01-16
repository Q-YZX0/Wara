import { Express, Request, Response } from 'express';
import { WaraNode } from '../node';

export const setupLeaderboardRoutes = (app: Express, node: WaraNode) => {
    // GET /api/leaderboard/content - Top Ranked Links
    app.get('/api/leaderboard/content', async (req, res) => {
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

};