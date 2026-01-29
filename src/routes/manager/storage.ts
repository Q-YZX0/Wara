import { Router, Request, Response } from 'express';
import { App } from '../../App';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../../config/config';
import { createWaraLink } from '../../utils/LinkCreator';

export const setupStorageRoutes = (node: App) => {
    const router = Router();

    // GET /api/manager/storage/links
    router.get('/storage-links', node.identity.requireAuth, async (req: Request, res: Response) => {
        const prismaContent = await node.prisma.link.findMany();
        const content = await node.catalog.getResolvedCatalog(prismaContent);
        res.json({ success: true, content });
    });

    // GET /api/manager/storage/links/:id
    router.get('/storage-links/:id', node.identity.requireAuth, async (req: Request, res: Response) => {
        const { id } = req.params;
        const link = node.catalog.links.get(id);
        if (!link) return res.status(404).json({ error: 'Link not found' });
        res.json({ success: true, link });
    });

    /**
     * DELETE /api/manager/storage/links/:id
     * Delete a link and its files from the node directly.
     */
    router.delete('/storage-links/:id', node.identity.requireAuth, async (req: Request, res: Response) => {
        const { id } = req.params;
        const link = node.catalog.links.get(id);

        if (!link) {
            return res.status(404).json({ error: "Link not found" });
        }

        try {
            // 1. Remove from Memory
            node.catalog.links.delete(id);

            // 2. Remove Files
            const waraPath = link.filePath;
            const jsonPath = waraPath.replace('.wara', '.json');

            if (fs.existsSync(waraPath)) fs.unlinkSync(waraPath);
            if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

            // 3. Cleanup Subtitles (Best effort)
            const dir = path.dirname(waraPath);
            const files = fs.readdirSync(dir);
            for (const f of files) {
                if (f.startsWith(`${id}_`)) {
                    try { fs.unlinkSync(path.join(dir, f)); } catch (e) { }
                }
            }

            console.log(`[App] Deleted link from node: ${id}`);
            res.json({ success: true });

        } catch (e) {
            console.error("Delete failed", e);
            res.status(500).json({ error: "Failed to delete files" });
        }
    });

    return router;
};