import { Router, Request, Response } from 'express';
import { App } from '../../App';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../../config/config';
import { WaraMap } from '../../types';
import { ethers } from 'ethers';
import { getMediaMetadata } from '../../utils/tmdb';

export const setupMirrorRoutes = (node: App) => {
    const router = Router();

    // POST /api/manager/mirror (Replication)
    router.post('/mirror', node.identity.requireAuth, async (req: Request, res: Response) => {
        try {
            const { outputUrl } = req.body;
            if (!outputUrl) return res.status(400).json({ error: "Missing outputUrl" });

            // 1. Authenticate Mirrorer
            const signer = node.identity.getAuthenticatedSigner(req);
            if (!signer) return res.status(401).json({ error: "Unauthorized: Active wallet session required for mirroring" });
            const mirrorerWallet = signer.address.toLowerCase();

            console.log(`[App] Mirroring content from ${outputUrl} for ${mirrorerWallet}...`);

            // 2. Fetch Remote Map
            const mapRes = await axios.get(`${outputUrl}/map`);
            if (mapRes.status !== 200) throw new Error("Could not fetch remote map");
            const map = mapRes.data as WaraMap;

            if (!map.waraId || (!map.hash && (map as any).contentHash)) {
                // Compatibility check: some old maps might use contentHash instead of hash
                map.hash = map.hash || (map as any).contentHash;
            }

            if (!map.waraId || !map.hash) {
                throw new Error("Remote map is missing critical identification (waraId or hash)");
            }

            // 3. Media Verification (Check local DB and Registry)
            let media = await node.prisma.media.findUnique({ where: { waraId: map.waraId } });

            if (!media && map.mediaInfo) {
                console.log(`[Mirror] Enriching media ${map.waraId} from remote metadata...`);
                const source = map.mediaInfo.source || 'tmdb';
                const sourceId = map.mediaInfo.sourceId || map.mediaInfo.tmdbId;

                if (sourceId) {
                    media = await getMediaMetadata(node.prisma, String(sourceId), map.mediaInfo.type || 'movie', 'pending_dao', node);
                }
            }

            if (!media) throw new Error("Could not identify media content for this mirror.");

            // 3.1 On-Chain Media Proposal (if missing)
            if (node.blockchain.mediaRegistry) {
                try {
                    const [exists] = await node.blockchain.mediaRegistry.exists(media.source, media.sourceId);
                    if (!exists) {
                        console.log(`[Mirror] Proposing Media ${media.sourceId} on-chain...`);
                        const tx = await (node.blockchain.mediaRegistry.connect(signer) as any).registerMedia(
                            media.source,
                            media.sourceId,
                            media.title,
                            media.waraId
                        );
                        await tx.wait();
                    }
                } catch (e: any) {
                    console.warn(`[Mirror] Media registry check/write failed: ${e.message}`);
                }
            }

            // 4. Download Stream
            const streamUrl = `${outputUrl}/stream`;
            const response = await axios.get(streamUrl, { responseType: 'arraybuffer' });
            if (response.status !== 200 || !response.data) throw new Error("Could not fetch remote stream");

            const buffer = Buffer.from(response.data);

            // 5. Generate NEW Link ID for this mirrorer
            const salt = `mirror-${Date.now()}`;
            const contentHash = map.hash.startsWith('0x') ? map.hash : `0x${map.hash}`;

            // 5.1 On-Chain Registration
            let txHash = null;
            if (node.blockchain.linkRegistry) {
                try {
                    console.log(`[Mirror] Registering Link on-chain for ${mirrorerWallet}...`);
                    const tx = await (node.blockchain.linkRegistry.connect(signer) as any).registerLink(
                        contentHash,
                        media.waraId,
                        salt,
                        mirrorerWallet
                    );
                    txHash = tx.hash;
                    console.log(`[Mirror] Link Registered: ${txHash}`);
                } catch (e: any) {
                    console.error(`[Mirror] Link registration failed: ${e.message}`);
                    throw new Error(`On-chain registration failed: ${e.message}`);
                }
            }

            // 5.2 Calculate final Link ID (must match Registry if we used the same parameters)
            const newLinkId = ethers.keccak256(
                ethers.solidityPacked(
                    ["bytes32", "address", "string", "bytes32"],
                    [contentHash, mirrorerWallet, salt, media.waraId]
                )
            );

            // 6. Save Files with NEW ID
            const permBase = path.join(CONFIG.DATA_DIR, 'permanent');
            if (!fs.existsSync(permBase)) fs.mkdirSync(permBase, { recursive: true });

            const localPath = path.join(permBase, `${newLinkId}.wara`);
            const localMapPath = path.join(permBase, `${newLinkId}.json`);

            fs.writeFileSync(localPath, buffer);

            // Update map for local serving
            const localMap = {
                ...map,
                id: newLinkId,
                hosterAddress: mirrorerWallet,
                publicEndpoint: `/stream/${newLinkId}`
            };
            fs.writeFileSync(localMapPath, JSON.stringify(localMap, null, 2));

            // 7. Local DB Record
            await node.prisma.link.create({
                data: {
                    id: newLinkId,
                    url: node.identity.nodeName || node.identity.publicIp || 'localhost',
                    title: media.title,
                    waraId: media.waraId,
                    source: media.source,
                    sourceId: media.sourceId,
                    mediaType: media.type,
                    season: map.mediaInfo?.season ?? null,
                    episode: map.mediaInfo?.episode ?? null,
                    uploaderWallet: mirrorerWallet,
                    waraMetadata: JSON.stringify({
                        hash: map.hash,
                        salt: salt,
                        mirroredFrom: outputUrl
                    })
                }
            });

            // 8. Activate in Memory
            node.catalog.registerLink(newLinkId, localPath, localMap, (map as any).key);

            res.json({
                success: true,
                linkId: newLinkId,
                txHash,
                mirroredFrom: outputUrl
            });

        } catch (e: any) {
            console.error(`[Mirror Error]`, e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
