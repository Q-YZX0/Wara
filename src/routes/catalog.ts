import { Express, Request, Response } from 'express';
import { ethers } from 'ethers';
import { WaraNode } from '../node';
import { getMediaMetadata, searchTMDB, getSeasonDetails } from '../tmdb';
import * as fs from 'fs';
import * as path from 'path';

export const setupCatalogRoutes = (app: Express, node: WaraNode) => {
    // Get full local catalog of links
    app.get('/api/catalog', async (req, res) => {
        try {
            const links = await node.prisma.link.findMany({
                orderBy: { createdAt: 'desc' }
            });
            res.json(links);
        } catch (e) {
            res.status(500).json({ error: 'Failed to fetch catalog' });
        }
    });

    // --- Image Serving Endpoints (P2P Metadata) ---
    app.get('/catalog/poster/:sourceId', (req: Request, res: Response) => {
        const { sourceId } = req.params;
        if (!/^[a-z0-9_-]+$/i.test(sourceId)) return res.status(400).end();

        const posterPath = path.join(node.dataDir, 'posters', `${sourceId}.jpg`);
        if (fs.existsSync(posterPath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000');
            res.sendFile(posterPath);
        } else {
            res.status(404).end();
        }
    });

    app.get('/catalog/backdrop/:sourceId', (req: Request, res: Response) => {
        const { sourceId } = req.params;
        if (!/^[a-z0-9_-]+$/i.test(sourceId)) return res.status(400).end();

        const backdropPath = path.join(node.dataDir, 'backdrops', `${sourceId}.jpg`);
        if (fs.existsSync(backdropPath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000');
            res.sendFile(backdropPath);
        } else {
            res.status(404).end();
        }
    });

    app.get('/catalog/episode-still/:sourceId/:season/:episode', (req: Request, res: Response) => {
        const { sourceId, season, episode } = req.params;
        if (!/^[a-z0-9_-]+$/i.test(sourceId) || !/^\d+$/.test(season) || !/^\d+$/.test(episode)) {
            return res.status(400).end();
        }

        const stillPath = path.join(node.dataDir, 'episode-stills', sourceId, `s${season}e${episode}.jpg`);
        if (fs.existsSync(stillPath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000');
            res.sendFile(stillPath);
        } else {
            res.status(404).end();
        }
    });

    // --- NEW: Public Catalog (For P2P Sync) ---
    app.get('/catalog', (req: Request, res: Response) => {
        const baseUrl = `http://${node.publicIp || 'localhost'}:${node.port}`;
        const hosterFilter = req.query.hoster as string;

        // Group links by tmdbId
        const mediaMap = new Map<string, any>();
        const episodes: any[] = [];

        for (const link of node.links.values()) {
            // Apply filter if provided
            if (hosterFilter && link.map.hosterAddress !== hosterFilter) continue;

            const info = link.map.mediaInfo;
            if (!info || !info.sourceId) continue;

            const sourceId = info.sourceId;
            const source = info.source || 'tmdb';

            // We send the internal local ID as a reference, 
            // but the blockchain identity will be its hash.
            const linkData: any = {
                linkId: link.id,
                title: link.map.title,
                endpoint: `${baseUrl}/wara/${link.id}`,
                key: link.key
            };

            if (info.type === 'episode' && info.season && info.episode) {
                linkData.sourceId = sourceId;
                linkData.source = source;
                linkData.season = info.season;
                linkData.episode = info.episode;
                episodes.push(linkData);
            }

            // Add or update media entry
            if (!mediaMap.has(sourceId)) {
                const hasPoster = fs.existsSync(path.join(node.dataDir, 'posters', `${sourceId}.jpg`));
                const hasBackdrop = fs.existsSync(path.join(node.dataDir, 'backdrops', `${sourceId}.jpg`));

                mediaMap.set(sourceId, {
                    sourceId,
                    source,
                    type: info.type,
                    title: info.title || link.map.title,
                    posterUrl: hasPoster ? `${baseUrl}/catalog/poster/${sourceId}` : null,
                    backdropUrl: hasBackdrop ? `${baseUrl}/catalog/backdrop/${sourceId}` : null,
                    hasLocalImages: hasPoster || hasBackdrop
                });
            }
        }

        res.json({
            media: Array.from(mediaMap.values()),
            episodes,
            nodeInfo: {
                nodeId: node.nodeId,
                nodeName: node.nodeName,
                endpoint: baseUrl
            }
        });
    });

    // ==========================================
    // CATALOG API (Frontend Consumption)
    // ==========================================

    // GET /api/catalog/recent?genre=Action
    app.get('/api/catalog/recent', async (req: Request, res: Response) => {
        const genre = req.query.genre as string;

        try {
            let movies = [];
            if (genre) {
                const linksWithGenre = await node.prisma.link.findMany({
                    distinct: ['waraId'],
                    select: { waraId: true, mediaType: true }
                });
                const waraIds = linksWithGenre.map(l => l.waraId);

                const mediaInGenre = await node.prisma.media.findMany({
                    where: {
                        waraId: { in: waraIds },
                        genre: { contains: genre },
                        status: 'approved'
                    },
                    take: 50,
                    orderBy: { createdAt: 'desc' }
                });
                movies = mediaInGenre.map(m => ({ base: m, isAvailable: true }));
            } else {
                const recentLinks = await node.prisma.link.findMany({
                    take: 50,
                    orderBy: { createdAt: 'desc' },
                    distinct: ['sourceId'],
                    select: { sourceId: true, mediaType: true, waraId: true }
                });

                movies = await Promise.all(recentLinks.map(async (link) => {
                    const metadata = await node.prisma.media.findUnique({
                        where: { waraId: link.waraId }
                    });
                    if (!metadata || metadata.status !== 'approved') return null;
                    return { base: metadata, isAvailable: true };
                }));
                movies = movies.filter(m => m !== null);
            }
            res.json(movies);
        } catch (e: any) {
            console.error("Catalog Recent Error", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/catalog/search?q=Matrix
    app.get('/api/catalog/search', async (req: Request, res: Response) => {
        const q = req.query.q as string;
        if (!q) return res.json([]);

        try {
            // 1. Search TMDB (Primary Discovery)
            let results: any[] = [];
            if (process.env.TMDB_API_KEY) {
                try {
                    results = await searchTMDB(q);
                } catch (e) { console.error("TMDB Search Error", e); }
            }

            // 2. Search Local DB (Fallback/Supplement)
            // Useful for offline mode or content not in TMDB
            const localResults = await node.prisma.media.findMany({
                where: { title: { contains: q } },
                take: 20
            });

            // 3. Merge & Deduplicate (Source of Truth: TMDB + Local Overlay)
            const resultMap = new Map<string, any>();

            // Add TMDB entries first
            results.forEach((m: any) => {
                resultMap.set(`${m.source}:${m.sourceId}`, { ...m, origin: 'tmdb' });
            });

            // Add/Overlay Local entries
            localResults.forEach(m => {
                const key = `${m.source}:${m.sourceId}`;
                const existing = resultMap.get(key);
                // If exists in TMDB, we just ensure we have the waraId attached for later logic
                // If not, we add it as a local-only result
                if (existing) {
                    resultMap.set(key, { ...existing, waraId: m.waraId });
                } else {
                    resultMap.set(key, { ...m, origin: 'local' });
                }
            });

            const mergedList = Array.from(resultMap.values());

            // 4. Batch Enrichment: Get Status & Link Counts
            const sourceIds = mergedList.map(m => m.sourceId);

            // 4a. Fetch Exact Media Status (Match by ID to be sure)
            const existingMedia = await node.prisma.media.findMany({
                where: {
                    sourceId: { in: sourceIds },
                    source: 'tmdb'
                }
            });

            // 4b. Fetch Link Counts
            const linkCounts = await node.prisma.link.groupBy({
                by: ['sourceId'],
                where: { sourceId: { in: sourceIds } },
                _count: { id: true }
            });

            // 5. Build Final Response with Local State Flags
            const enrichedResults = mergedList.map(item => {
                // Find matching DB entry (Priority: Exact ID match)
                const dbEntry = existingMedia.find(m => m.sourceId === item.sourceId)
                    || localResults.find(m => m.sourceId === item.sourceId);

                const linkStats = linkCounts.find(l => l.sourceId === item.sourceId);
                const count = linkStats ? linkStats._count.id : 0;

                return {
                    base: {
                        ...item,
                        waraId: dbEntry ? dbEntry.waraId : item.waraId,
                        status: dbEntry ? dbEntry.status : item.status,
                    },
                    isAvailable: count > 0,
                    localState: {
                        registered: !!dbEntry,
                        status: dbEntry ? dbEntry.status : null,
                        linkCount: count,
                        isPlayable: count > 0,
                    }
                };
            });

            res.json(enrichedResults);
        } catch (e: any) {
            console.error("Search Error", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/catalog/unverified (Community Uploads - Playable but not DAO Approved)
    app.get('/api/catalog/unverified', async (req: Request, res: Response) => {
        console.log(`[Catalog] GET /unverified Request received. Query:`, req.query);
        const genre = req.query.genre as string;
        try {
            // 1. Find all links first (Source of Truth for Availability)
            const allLinks = await node.prisma.link.findMany({
                distinct: ['sourceId'],
                select: { sourceId: true }
            });
            const availableSourceIds = allLinks.map(l => l.sourceId);

            if (availableSourceIds.length === 0) {
                console.log(`[Catalog] /unverified: No links found in DB.`);
                return res.json([]);
            }

            // 2. Find Media that MATCHES these links but is NOT approved
            const unverifiedMedia = await node.prisma.media.findMany({
                where: {
                    sourceId: { in: availableSourceIds },
                    status: { not: 'approved' },
                    ...(genre ? { genre: { contains: genre } } : {})
                },
                take: 50,
                orderBy: { createdAt: 'desc' }
            });

            const movies = unverifiedMedia.map(m => ({ base: m, isAvailable: true }));
            res.json(movies);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/catalog/requests (Requested but NO content available yet)
    app.get('/api/catalog/requests', async (req: Request, res: Response) => {
        const genre = req.query.genre as string;
        try {
            // 1. Find all links to EXCLUDE them
            const allLinks = await node.prisma.link.findMany({
                distinct: ['sourceId'],
                select: { sourceId: true }
            });
            const availableSourceIds = new Set(allLinks.map(l => l.sourceId));

            // 2. Find Media requested
            const requestedMedia = await node.prisma.media.findMany({
                where: {
                    ...(genre ? { genre: { contains: genre } } : {}),
                    OR: [
                        { requestCount: { gt: 0 } },
                        { status: 'pending_dao' }
                    ]
                },
                take: 50,
                orderBy: { requestCount: 'desc' }
            });

            // 3. Filter out anything that is already available
            const movies = requestedMedia
                .filter(m => !availableSourceIds.has(m.sourceId))
                .map(m => ({ base: m, isAvailable: false }));

            res.json(movies);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/catalog/request', async (req: Request, res: Response) => {
        const { mediaId, source = 'tmdb', sourceId, type = 'movie' } = req.body;
        if (!mediaId && !sourceId) return res.status(400).json({ error: 'Missing mediaId or sourceId' });

        const finalSourceId = sourceId || mediaId; // In case mediaId was used as sourceId

        // 0. Strict Identity Check (Must be an active USER session)
        const authToken = (req.headers['x-auth-token'] || req.body.authToken) as string;
        const signer = node.activeWallets.get(authToken);
        if (!signer) return res.status(401).json({ error: "Unauthorized: Active USER session required" });

        try {
            // 1. Ensure Media/Hash exists on Blockchain (Lazy Registration)
            if (node.mediaRegistry) {
                let onChain = false;
                try {
                    const [exists] = await node.mediaRegistry.exists(String(source), String(finalSourceId));
                    onChain = exists;
                } catch (e: any) {
                    console.warn(`[Catalog] Registry check failed: ${e.message}`);
                }

                // Fetch Metadata locally first to have the data ready for registration
                // We default to 'pending_dao' since we don't know the status yet if not on chain
                const media = await getMediaMetadata(node.prisma, String(finalSourceId), String(type), 'pending_dao', node, String(source));

                if (!onChain && media) {
                    // 1.1 Universal Request Registration (Proposal)
                    try {
                        console.log(`[Web3] Registering Requested Media on-chain: ${media.title}`);
                        const registryWrite = node.mediaRegistry.connect(signer);
                        const tx = await (registryWrite as any).registerMedia(
                            String(media.source),
                            String(media.sourceId),
                            media.title,
                            media.waraId
                        );
                        console.log(`[Web3] Request TX Sent: ${tx.hash}`);
                    } catch (e: any) {
                        console.warn(`[Web3] Request registration failed: ${e.message}`);
                    }
                }
            }

            // 2. Increment Request Count
            let updated;
            if (mediaId && mediaId !== "") {
                try {
                    updated = await node.prisma.media.update({
                        where: { waraId: mediaId },
                        data: { requestCount: { increment: 1 } }
                    });
                } catch (e) { /* fallback below */ }
            }

            if (!updated) {
                updated = await node.prisma.media.update({
                    where: { source_sourceId: { source: String(source), sourceId: String(finalSourceId) } },
                    data: { requestCount: { increment: 1 } }
                });
            }

            res.json({ success: true, newCount: updated.requestCount });
        } catch (e: any) {
            console.error("[Catalog] Request Error:", e.message);
            res.status(500).json({ error: 'Failed to request media: ' + e.message });
        }
    });

    app.get('/api/catalog/meta/:id', async (req: Request, res: Response) => {
        const type = (req.query.type as string) || 'movie';
        const data = await getMediaMetadata(node.prisma, req.params.id, type, 'approved', node);
        res.json(data || {});
    });

    app.get('/api/catalog/meta/:id/season/:season', async (req: Request, res: Response) => {
        const data = await getSeasonDetails(node.prisma, req.params.id, Number(req.params.season));
        res.json(data || {});
    });

    // --- TMDB Key Management ---
    app.get('/api/tmdb-key', (req: Request, res: Response) => {
        res.json({ apiKey: process.env.TMDB_API_KEY || '' });
    });

    app.post('/api/tmdb-key', (req: Request, res: Response) => {
        const { apiKey } = req.body;
        if (!apiKey) return res.status(400).json({ error: 'Key required' });

        process.env.TMDB_API_KEY = apiKey;

        // Note: For persistence, in a real scenario we would write to .env
        // But for runtime update, this works.
        res.json({ success: true });
    });
};
