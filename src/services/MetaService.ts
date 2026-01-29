import { PrismaClient } from '@prisma/client';
import { ethers } from 'ethers';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { CONFIG } from '../config/config';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

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

/**
 * MetaService: Sovereign Metadata Resolver
 * Prioritizes P2P Neighborhood discovery over external sources like TMDB.
 */
export class MetaService {
    /**
     * Resolves rich metadata for a given content.
     */
    static async getMediaMetadata(prisma: PrismaClient, sourceId: string, type: string = 'movie', status: string = 'approved', node?: any, source: string = 'tmdb', extraMeta: any = {}, onChain: boolean = true) {
        if (!process.env.TMDB_API_KEY && !node && source === 'tmdb') return null;

        try {
            const waraId = ethers.solidityPackedKeccak256(["string", "string"], [String(source), `:${String(sourceId)}`]);

            // 1. Check existing to prevent redundant fetches
            const existing = await prisma.media.findUnique({ where: { waraId } });
            if (existing) {
                if (existing.status === 'rejected' && status !== 'approved') return existing;
                const isValid = existing.title && existing.overview && existing.title !== 'Unknown';
                if (isValid && status !== 'approved') return existing;
            }

            // 2. NEIGHBORHOOD P2P RESOLVER
            if (node && node.knownPeers && onChain) {
                const peers = Array.from(node.knownPeers.values()) as any[];
                const targets = peers
                    .filter(p => p.endpoint && p.isTrusted !== false)
                    .sort(() => 0.5 - Math.random())
                    .slice(0, 5);

                if (targets.length > 0) {
                    const results = await Promise.allSettled(targets.map(async (peer) => {
                        const res = await axios.get(`${peer.endpoint}/api/media/stream/${waraId}`, { timeout: 3000 });
                        if (res.status === 200 && res.data.overview) return { metadata: res.data, peer };
                        throw new Error("Peer lacks manifest");
                    }));

                    for (const res of results) {
                        if (res.status === 'fulfilled' && res.value) {
                            const { metadata, peer } = res.value;

                            // Peer Image Sync
                            const postersDir = path.join(CONFIG.DATA_DIR, 'posters');
                            if (!fs.existsSync(postersDir)) fs.mkdirSync(postersDir, { recursive: true });
                            const posterDest = path.join(postersDir, `${metadata.sourceId}.jpg`);
                            if (!fs.existsSync(posterDest)) {
                                downloadImage(`${peer.endpoint}/api/catalog/poster/${metadata.sourceId}`, posterDest).catch(() => { });
                            }

                            const saved = await prisma.media.upsert({
                                where: { waraId },
                                update: { ...metadata, status: status },
                                create: { ...metadata, status: status }
                            });

                            MetaService.saveManifestLocally(waraId, saved);
                            return saved;
                        }
                    }
                }
            }

            // 3. Custom / Non-TMDB Source
            if (source !== 'tmdb') {
                const title = extraMeta.title || `Unknown (${sourceId})`;
                const media = await prisma.media.upsert({
                    where: { waraId },
                    update: { status, updatedAt: new Date() },
                    create: {
                        waraId, source, sourceId, type, title,
                        releaseDate: extraMeta.year || new Date().getFullYear().toString(),
                        posterPath: extraMeta.poster || null,
                        backdropPath: extraMeta.backdrop || null,
                        overview: extraMeta.overview || extraMeta.plot || "Custom content",
                        status,
                        genre: "Custom"
                    }
                });
                MetaService.saveManifestLocally(waraId, media);
                return media;
            }

            // 4. Fallback to TMDB
            if (!process.env.TMDB_API_KEY) return existing;

            const res = await axios.get(`${TMDB_BASE_URL}/${type}/${sourceId}?api_key=${process.env.TMDB_API_KEY}&append_to_response=credits,videos,similar`);
            if (res.status !== 200) return null;

            const data = res.data;

            // Image Downloads
            if (data.poster_path) {
                const postersDir = path.join(CONFIG.DATA_DIR, 'posters');
                if (!fs.existsSync(postersDir)) fs.mkdirSync(postersDir, { recursive: true });
                const dest = path.join(postersDir, `${data.id}.jpg`);
                if (!fs.existsSync(dest)) {
                    downloadImage(`https://image.tmdb.org/t/p/w500${data.poster_path}`, dest).catch(() => { });
                }
            }

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
                    waraId, source: 'tmdb', sourceId: String(data.id),
                    type, title: type === 'movie' ? data.title : data.name,
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

            MetaService.saveManifestLocally(waraId, media);
            return media;

        } catch (e) {
            console.error("[MetaService] Resolution error:", e);
            return null;
        }
    }

    private static saveManifestLocally(waraId: string, media: any) {
        try {
            const manifestPath = path.join(CONFIG.DATA_DIR, 'media', `${waraId}.json`);
            if (!fs.existsSync(path.dirname(manifestPath))) fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
            fs.writeFileSync(manifestPath, JSON.stringify(media, null, 2));
        } catch (e) {
            console.error("[MetaService] Manifest save error:", e);
        }
    }

    static async search(query: string) {
        if (!process.env.TMDB_API_KEY) return [];
        try {
            const res = await axios.get(`${TMDB_BASE_URL}/search/multi?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(query)}`);
            if (res.status !== 200) return [];
            return res.data.results
                .filter((d: any) => d.media_type === 'movie' || d.media_type === 'tv')
                .map((d: any) => ({
                    source: 'tmdb',
                    sourceId: String(d.id),
                    type: d.media_type,
                    title: d.media_type === 'movie' ? d.title : d.name,
                    releaseDate: (d.media_type === 'movie' ? d.release_date : d.first_air_date) || null,
                    posterPath: d.poster_path || null,
                    overview: d.overview
                }));
        } catch (e) {
            console.error("[MetaService] Search error:", e);
            return [];
        }
    }

    static async getSeasonDetails(sourceId: string, seasonNumber: number) {
        if (!process.env.TMDB_API_KEY) return null;
        try {
            const res = await axios.get(`${TMDB_BASE_URL}/tv/${sourceId}/season/${seasonNumber}?api_key=${process.env.TMDB_API_KEY}`);
            return res.status === 200 ? res.data : null;
        } catch (e) {
            console.error("[MetaService] Season Fetch error:", e);
            return null;
        }
    }
}
