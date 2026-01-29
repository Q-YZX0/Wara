import { Router, Request, Response } from 'express';
import { App } from '../../App';

export const setupTrackersRoutes = (node: App) => {
    const router = Router();

    // GET /api/manager/trackers (List)
    router.get('/trackers', node.identity.requireAuth, (req: Request, res: Response) => {
        res.json({ trackers: node.p2p.getTrackers() });
    });

    // PUT /api/manager/trackers (Add One)
    router.put('/trackers', node.identity.requireAuth, (req: Request, res: Response) => {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'Missing tracker URL' });
        node.p2p.addTracker(url);
        res.json({ success: true, trackers: node.p2p.getTrackers() });
    });

    // DELETE /api/manager/trackers (Remove One)
    router.delete('/trackers', node.identity.requireAuth, (req: Request, res: Response) => {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'Missing tracker URL' });
        node.p2p.removeTracker(url);
        res.json({ success: true, trackers: node.p2p.getTrackers() });
    });

    // POST /api/manager/trackers (Bulk Replace)
    router.post('/trackers', node.identity.requireAuth, (req: Request, res: Response) => {
        const { trackers } = req.body;
        if (!Array.isArray(trackers)) return res.status(400).json({ error: 'trackers must be an array' });

        node.p2p.trackers = trackers.filter((t: any) => typeof t === 'string' && t.length > 0);
        console.log(`[App] Trackers updated: ${node.p2p.getTrackers().join(', ')}`);
        node.p2p.saveTrackers();

        res.json({ success: true, trackers: node.p2p.getTrackers() });
    });

    return router;
};
