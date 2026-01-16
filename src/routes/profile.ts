import { Express, Request, Response } from 'express';
import { WaraNode } from '../node';

export const setupProfileRoutes = (app: Express, node: WaraNode) => {

    // GET /api/profile/preferences
    app.get('/api/profile/preferences', async (req: Request, res: Response) => {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });
        try {
            const profile = await node.prisma.localProfile.findUnique({ where: { id: String(userId) }, select: { preferredLanguage: true } });
            res.json(profile || { preferredLanguage: 'es' });
        } catch (e) {
            res.status(500).json({ error: 'Failed to fetch preferences' });
        }
    });

    // POST /api/profile/preferences
    app.post('/api/profile/preferences', async (req: Request, res: Response) => {
        const { userId, preferredLanguage } = req.body;
        if (!userId || !preferredLanguage) return res.status(400).json({ error: 'Missing parameters' });
        try {
            await node.prisma.localProfile.update({ where: { id: String(userId) }, data: { preferredLanguage: String(preferredLanguage) } });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Failed to save preferences' });
        }
    });
};  