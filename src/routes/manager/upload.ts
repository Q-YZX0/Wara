import { Router, Request, Response } from 'express';
import { App } from '../../App';
import { CONFIG } from '../../config/config';
import { createWaraLink } from '../../utils/LinkCreator';

import fs from 'fs';
import path from 'path';

export const setupUploadRoutes = (node: App) => {
    const router = Router();

    // POST /api/manager/import
    // Upload a file and create a link
    router.post('/import', node.identity.requireAuth, async (req: Request, res: Response) => {
        console.log(`[App] INCOMING IMPORT REQUEST`);
        const filename = req.headers['x-filename'] as string || `upload_${Date.now()}.mp4`;
        const title = req.headers['x-title'] as string || filename;
        const hosterAddress = req.headers['x-hoster'] as string;
        const mediaInfoStr = req.headers['x-mediainfo'] as string || '{}';

        console.log(`[App] Headers: Title=${title}, Filename=${filename}, Hoster=${hosterAddress}`);
        const tempBase = path.join(CONFIG.DATA_DIR, 'temp');
        if (!fs.existsSync(tempBase)) fs.mkdirSync(tempBase, { recursive: true });

        const tempPath = path.join(tempBase, filename);

        const writeStream = fs.createWriteStream(tempPath);
        req.pipe(writeStream);

        writeStream.on('finish', async () => {
            try {
                console.log(`[WaraNode] File received. Encrypting...`);
                const mediaInfo = JSON.parse(mediaInfoStr);
                // Standardize mediaInfo if needed
                if (mediaInfo.tmdbId && !mediaInfo.sourceId) {
                    mediaInfo.sourceId = String(mediaInfo.tmdbId);
                    mediaInfo.source = mediaInfo.source || 'tmdb';
                }

                const result = await createWaraLink(tempPath, title, tempBase, mediaInfo, hosterAddress);
                const nodeIdentifier = node.identity.nodeName || node.blockchain.wallet?.address || 'unknown';
                const portableUrl = `http://${nodeIdentifier}/stream/${result.map.id}#${result.key}`;

                res.json({
                    success: true,
                    linkId: result.map.id,
                    key: result.key,
                    map: { ...result.map, publicEndpoint: portableUrl }
                });
            } catch (e) {
                console.error("Encryption failed after upload", e);
                res.status(500).json({ error: "Processing failed" });
            }
        });

        writeStream.on('error', (err) => {
            console.error("Upload stream error", err);
            res.status(500).json({ error: "Upload failed" });
        });
    });

    // POST /api/manager/publish
    // Publish a file to the network
    router.post('/publish', node.identity.requireAuth, async (req: Request, res: Response) => {
        try {
            const { filePath, title, mediaInfo } = req.body;
            if (!filePath || !title) return res.status(400).json({ error: 'Missing filePath or title' });
            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Source file not found' });

            console.log(`[App] Admin requested publish: ${title}`);
            const result = await createWaraLink(filePath, title, CONFIG.DATA_DIR, mediaInfo);
            node.catalog.registerLink(result.map.id, result.encryptedPath, result.map, result.key);

            const effectiveHost = node.identity.publicIp ? node.identity.publicIp : 'localhost';
            const endpointWithKey = `http://${effectiveHost}:${CONFIG.PORT}/stream/${result.map.id}#${result.key}`;

            res.json({
                success: true,
                linkId: result.map.id,
                key: result.key,
                map: { ...result.map, publicEndpoint: endpointWithKey }
            });

        } catch (e: any) {
            console.error(e);
            res.status(500).json({ error: e.message });
        }
    });



    // POST /api/manager/subtitle
    // Upload subtitle for a link
    router.post('/subtitle', node.identity.requireAuth, (req: Request, res: Response) => {
        const linkId = req.headers['x-link-id'] as string;
        const lang = req.headers['x-lang'] as string;
        const label = req.headers['x-label'] as string;
        const filename = req.headers['x-filename'] as string;

        if (!linkId || !lang || !node.catalog.links.has(linkId)) {
            return res.status(404).json({ error: 'Link not found' });
        }

        const link = node.catalog.links.get(linkId)!;
        // Determine extension. Prefer vtt.
        let ext = 'vtt';
        if (filename && filename.endsWith('.srt')) ext = 'srt';

        const subFileName = `${linkId}_${lang}.${ext}`;
        const subFilePath = path.join(CONFIG.DATA_DIR, subFileName);

        const writeStream = fs.createWriteStream(subFilePath);
        req.pipe(writeStream);

        writeStream.on('finish', () => {
            // Cleanup conflicting extensions (priority issue)
            const otherExt = ext === 'vtt' ? 'srt' : 'vtt';
            const otherFile = path.join(CONFIG.DATA_DIR, `${linkId}_${lang}.${otherExt}`);
            try { if (fs.existsSync(otherFile)) fs.unlinkSync(otherFile); } catch (e) { }

            // Update Link Map
            if (!link.map.subtitles) link.map.subtitles = [];
            // Remove existing if any (Case Insensitive + Trim)
            const targetLang = lang.trim().toLowerCase();
            link.map.subtitles = link.map.subtitles.filter(s => (s.lang || '').trim().toLowerCase() !== targetLang);

            link.map.subtitles.push({
                id: `${linkId}_${lang}`,
                lang,
                label: label || lang.toUpperCase()
            });

            // Persist new map to JSON
            try {
                const mapPath = path.join(CONFIG.DATA_DIR, `${linkId}.json`);
                fs.writeFileSync(mapPath, JSON.stringify(link.map, null, 2));
                console.log(`[App] Subtitle added: ${lang} for ${linkId}`);
                res.json({ success: true });
            } catch (e) {
                console.error("Failed to update map json", e);
                res.status(500).json({ error: "Map update failed" });
            }
        });

        writeStream.on('error', (err) => {
            console.error("Subtitle upload failed", err);
            res.status(500).json({ error: "Write failed" });
        });
    });

    return router;
};
