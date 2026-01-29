import { Router, Request, Response } from 'express';
import { App } from '../../App';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../../config/config';

export const setupProofsRoutes = (node: App) => {
    const router = Router();

    // GET /api/manager/proofs (Audit proofs)
    router.get('/proofs', node.identity.requireAuth, async (req: Request, res: Response) => {
        try {
            const { hoster } = req.query;
            const signer = node.identity.getAuthenticatedSigner(req);
            if (!signer) return res.status(401).json({ error: 'Authentication required' });

            const targetWallet = ((hoster as string) || (signer as any).address).toLowerCase();
            const proofsDir = path.join(CONFIG.DATA_DIR, 'proofs');
            if (!fs.existsSync(proofsDir)) return res.json([]);

            const files = fs.readdirSync(proofsDir).filter(f => f.endsWith('.json'));
            const proofs = files.map(f => {
                const data = JSON.parse(fs.readFileSync(path.join(proofsDir, f), 'utf8'));
                return { ...data, _filename: f };
            });

            const filtered = proofs.filter(p => (p.uploaderWallet || '').toLowerCase() === targetWallet);
            res.json(filtered);
        } catch (e) {
            console.error("Proof audit error", e);
            res.status(500).json({ error: 'Could not read proofs' });
        }
    });

    // POST /api/manager/proofs/delete (Batch Delete Proofs after on-chain claim)
    router.post('/proofs/delete', node.identity.requireAuth, (req: Request, res: Response) => {
        const { filenames } = req.body;
        if (!Array.isArray(filenames)) return res.status(400).json({ error: 'Filenames array required' });

        const proofsDir = path.join(CONFIG.DATA_DIR, 'proofs');
        let deleted = 0;

        filenames.forEach(f => {
            if (!/^[a-z0-9_.-]+$/i.test(f)) return; // Security
            const p = path.join(proofsDir, f);
            try {
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                    deleted++;
                }
            } catch (e) { }
        });

        console.log(`[App] Deleted ${deleted} claimed proofs.`);
        res.json({ success: true, deleted });
    });

    // --- VOTE AUDIT ENDPOINTS ---

    // GET /api/manager/votes?wallet=0x... - Get all votes this node needs to process (where wallet is relayer)
    router.get('/votes', node.identity.requireAuth, async (req: Request, res: Response) => {
        try {
            const { wallet } = req.query;
            const signer = node.identity.getAuthenticatedSigner(req);
            const targetWallet = (wallet as string || (signer as any)?.address || "").toLowerCase();

            if (!targetWallet) return res.status(400).json({ error: 'Missing wallet or session' });

            const votesDir = path.join(CONFIG.DATA_DIR, 'votes');
            if (!fs.existsSync(votesDir)) return res.json({ votes: [] });

            const files = fs.readdirSync(votesDir).filter(f => f.endsWith('.json'));
            const matches: any[] = [];

            for (const f of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(votesDir, f), 'utf8'));
                    // Only care about votes where WE are the relayer (responsible for submission)
                    if ((data.relayer || '').toLowerCase() === targetWallet) {
                        matches.push({ ...data, _filename: f });
                    }
                } catch (e) { }
            }

            // Fetch metadata links in batch
            if (matches.length > 0) {
                const linkIds = Array.from(new Set(matches.map(v => v.linkId)));
                const links = await node.prisma.link.findMany({
                    where: { id: { in: linkIds } }
                });
                const linkMap = new Map(links.map(l => [l.id, l]));
                matches.forEach(v => v.link = linkMap.get(v.linkId));
            }

            res.json({ votes: matches });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/manager/votes/delete (Batch Delete Votes proof after on-chain sync)
    router.post('/votes/delete', node.identity.requireAuth, (req: Request, res: Response) => {
        const { filenames } = req.body;
        if (!Array.isArray(filenames)) return res.status(400).json({ error: 'Filenames array required' });

        const votesDir = path.join(CONFIG.DATA_DIR, 'votes');
        let deleted = 0;

        filenames.forEach(f => {
            if (!/^[a-z0-9_.-]+$/i.test(f)) return; // Security
            const p = path.join(votesDir, f);
            try {
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                    deleted++;
                }
            } catch (e) { }
        });

        console.log(`[App] Deleted ${deleted} synced votes.`);
        res.json({ success: true, deleted });
    });

    return router;
};
