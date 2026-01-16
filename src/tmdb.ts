import { PrismaClient } from '@prisma/client';

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const fs = require('fs');
const path = require('path');
const https = require('https');

async function downloadImage(url: string, destPath: string) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https.get(url, (response: any) => {
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to download: ${response.statusCode}`));
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve(true);
            });
        }).on('error', (err: any) => {
            fs.unlink(destPath, () => { });
            reject(err);
        });
    });
}

export async function getMediaMetadata(prisma: PrismaClient, sourceId: string, type: string = 'movie', status: string = 'approved', node?: any, source: string = 'tmdb', extraMeta: any = {}) {
    if (!TMDB_API_KEY && !node && source === 'tmdb') return null;

    try {
        const { ethers } = require('ethers');
        const waraId = ethers.solidityPackedKeccak256(["string", "string"], [String(source), `:${String(sourceId)}`]);

        // 1. Check existing to prevent redundant fetches
        const existing = await prisma.media.findUnique({ where: { waraId } });
        if (existing) {
            if (existing.status === 'rejected' && status !== 'approved') return existing;

            // Check if metadata is actually valid/complete
            const isValid = existing.title && existing.overview && existing.title !== 'Unknown';
            if (isValid && status !== 'approved') return existing;

            console.log(`[Metadata] Existing metadata for ${waraId} is incomplete or updating. Refreshing...`);
        }

        // 2. NEIGHBORHOOD P2P RESOLVER: Search known peers for the manifest
        if (node && node.knownPeers) {
            const peers = Array.from(node.knownPeers.values()) as any[];
            const targets = peers
                .filter(p => p.endpoint && p.isTrusted !== false)
                .sort(() => 0.5 - Math.random())
                .slice(0, 5);

            if (targets.length > 0) {
                console.log(`[P2P] Neighborhood Discovery: Searching ${targets.length} peers for ${waraId}...`);

                const results = await Promise.allSettled(targets.map(async (peer) => {
                    const res = await fetch(`${peer.endpoint}/api/media/wara/${waraId}`, {
                        signal: (AbortSignal as any).timeout ? (AbortSignal as any).timeout(3000) : undefined
                    });
                    if (res.ok) {
                        const p2m = await res.json();
                        if (p2m && p2m.overview) return p2m;
                    }
                    throw new Error("Peer lacks manifest");
                }));

                for (const res of results) {
                    if (res.status === 'fulfilled' && res.value) {
                        console.log(`[P2P] Metadata resolved from neighborhood for ${waraId}`);
                        return await prisma.media.upsert({
                            where: { waraId },
                            update: { ...res.value, status: status },
                            create: { ...res.value, status: status }
                        });
                    }
                }
            }
        }

        // 3. Custom / Non-TMDB Source
        if (source !== 'tmdb') {
            console.log(`[Metadata] Using Custom Metadata for ${source}:${sourceId}`);
            // Use extraMeta or valid defaults
            const title = extraMeta.title || `Unknown (${sourceId})`;
            const year = extraMeta.year || new Date().getFullYear().toString();

            const media = await prisma.media.upsert({
                where: { waraId },
                update: {
                    status,
                    updatedAt: new Date()
                },
                create: {
                    waraId,
                    source,
                    sourceId,
                    type,
                    title,
                    releaseDate: year,
                    posterPath: extraMeta.poster || null,
                    backdropPath: extraMeta.backdrop || null,
                    overview: extraMeta.overview || extraMeta.plot || "Custom content",
                    status,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    imdbId: null,
                    genre: "Custom"
                }
            });

            // SAVE SOVEREIGN MANIFEST
            try {
                const dataDir = path.join(process.cwd(), 'wara_store');
                const manifestPath = path.join(dataDir, 'media', `${waraId}.json`);
                if (!fs.existsSync(path.dirname(manifestPath))) fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
                fs.writeFileSync(manifestPath, JSON.stringify(media, null, 2));
            } catch (e) {
                console.error("[Custom] Manifest save error:", e);
            }
            return media;
        }

        // 4. Fallback to TMDB
        if (!TMDB_API_KEY) {
            console.log(`[Metadata] No TMDB key and Neighborhood search failed for ${waraId}.`);
            return existing;
        }

        const res = await fetch(`${TMDB_BASE_URL}/${type}/${sourceId}?api_key=${TMDB_API_KEY}&append_to_response=credits,videos,similar`);
        if (!res.ok) return null;

        const data = await res.json();

        // Download Images
        const dataDir = path.join(process.cwd(), 'wara_store');
        if (data.poster_path) {
            const postersDir = path.join(dataDir, 'posters');
            if (!fs.existsSync(postersDir)) fs.mkdirSync(postersDir, { recursive: true });
            const dest = path.join(postersDir, `${data.id}.jpg`);
            if (!fs.existsSync(dest)) {
                await downloadImage(`https://image.tmdb.org/t/p/w500${data.poster_path}`, dest).catch(console.error);
            }
        }
        if (data.backdrop_path) {
            const backdropsDir = path.join(dataDir, 'backdrops');
            if (!fs.existsSync(backdropsDir)) fs.mkdirSync(backdropsDir, { recursive: true });
            const dest = path.join(backdropsDir, `${data.id}.jpg`);
            if (!fs.existsSync(dest)) {
                await downloadImage(`https://image.tmdb.org/t/p/w1280${data.backdrop_path}`, dest).catch(console.error);
            }
        }

        // Compute WaraID
        const currentStatus = (existing?.status === 'rejected' && status !== 'approved') ? 'rejected' : status;

        const media = await prisma.media.upsert({
            where: { waraId },
            update: {
                genre: data.genres?.map((g: any) => g.name).join(', ') || null,
                overview: data.overview || '',
                posterPath: data.poster_path || null,
                backdropPath: data.backdrop_path || null,
                extendedInfo: JSON.stringify({
                    credits: data.credits,
                    videos: data.videos?.results || [],
                    similar: data.similar?.results || [],
                    seasons: data.seasons || []
                }),
                status: currentStatus
            },
            create: {
                waraId,
                source: 'tmdb',
                sourceId: String(data.id),
                imdbId: data.imdb_id || null,
                type,
                title: type === 'movie' ? data.title : data.name,
                genre: data.genres?.map((g: any) => g.name).join(', ') || null,
                overview: data.overview || '',
                posterPath: data.poster_path || null,
                backdropPath: data.backdrop_path || null,
                releaseDate: type === 'movie' ? data.release_date : data.first_air_date,
                extendedInfo: JSON.stringify({
                    credits: data.credits,
                    videos: data.videos?.results || [],
                    similar: data.similar?.results || [],
                    seasons: data.seasons || []
                }),
                status: currentStatus
            }
        });

        // SAVE SOVEREIGN MANIFEST
        try {
            const manifestPath = path.join(dataDir, 'media', `${waraId}.json`);
            if (!fs.existsSync(path.dirname(manifestPath))) fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
            fs.writeFileSync(manifestPath, JSON.stringify(media, null, 2));
        } catch (e) {
            console.error("[TMDB] Manifest save error:", e);
        }

        return media;
    } catch (e) {
        console.error("[TMDB] Fetch error:", e);
        return null;
    }
}

export async function getSeasonDetails(prisma: PrismaClient, sourceId: string, seasonNumber: number) {
    if (!TMDB_API_KEY) return null;
    try {
        const res = await fetch(`${TMDB_BASE_URL}/tv/${sourceId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data;
    } catch (e) {
        console.error("[TMDB] Season Fetch error:", e);
        return null;
    }
}

export async function searchTMDB(query: string) {
    if (!TMDB_API_KEY) return [];
    try {
        const res = await fetch(`${TMDB_BASE_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`);
        if (!res.ok) return [];
        const data = await res.json();

        return data.results
            .filter((d: any) => d.media_type === 'movie' || d.media_type === 'tv')
            .map((d: any) => ({
                source: 'tmdb',
                sourceId: String(d.id),
                type: d.media_type,
                title: d.media_type === 'movie' ? d.title : d.name,
                year: (d.media_type === 'movie' ? d.release_date : d.first_air_date)?.substring(0, 4) || '?',
                poster: d.poster_path ? `https://image.tmdb.org/t/p/w200${d.poster_path}` : null,
                overview: d.overview
            }));
    } catch (e) {
        console.error("[TMDB] Search error:", e);
        return [];
    }
}
