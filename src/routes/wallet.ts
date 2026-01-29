import { Router, Request, Response } from 'express';
import { App } from '../App';
import { ethers } from 'ethers';
import axios from 'axios';
import { decryptPayload } from '../utils/encryption';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../config/config';

export const setupWalletRoutes = (node: App) => {
    const router = Router();
    // ==========================================
    // WALLET & BLOCKCHAIN API  
    // ==========================================

    // GET /api/wallet/balances?address=0x... (Legacy - public)
    router.get('/balances', async (req: Request, res: Response) => {
        const { address } = req.query;
        if (!address) return res.status(400).json({ error: 'Missing address' });

        try {
            // Normalize address - try to fix checksum, fallback to original
            let normalizedAddress: string;
            try {
                normalizedAddress = ethers.getAddress(address as string);
            } catch (e) {
                // If checksum validation fails, use address as-is (ethers will handle it)
                normalizedAddress = (address as string).toLowerCase();
            }

            const provider = node.blockchain.provider;

            // ETH Balance
            const ethBal = await provider.getBalance(normalizedAddress);

            // WARA Balance
            const waraBal = await node.blockchain.token!.balanceOf(normalizedAddress);

            res.json({
                eth: ethers.formatEther(ethBal),
                wara: ethers.formatUnits(waraBal, 18),
                waraAddress: node.blockchain.token!.address
            });
        } catch (e: any) {
            console.error("Balance fetch failed", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/wallet/my-balances?userId=xxx (Secure - uses DB)
    router.get('/my-balances', async (req: Request, res: Response) => {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });

        try {
            // Get user's wallet address from DB
            const profile = await node.prisma.localProfile.findUnique({
                where: { id: String(userId) }
            });

            if (!profile || !profile.walletAddress) {
                return res.status(404).json({ error: 'User not found or no wallet linked' });
            }

            const rpcUrl = CONFIG.RPC_URL;
            const provider = node.blockchain.provider;

            let ethBal = BigInt(0);
            let waraBal = BigInt(0);

            try {
                ethBal = await provider.getBalance(profile.walletAddress);
                waraBal = await node.blockchain.token!.balanceOf(profile.walletAddress);
            } catch (rpcError) {
                console.warn(`[App] Blockchain RPC Unreachable at ${rpcUrl}. Returning 0 balances.`);
            }

            res.json({
                eth: ethers.formatEther(ethBal),
                wara: ethers.formatUnits(waraBal, 18),
                waraAddress: node.blockchain.token!.address,
                address: profile.walletAddress
            });
        } catch (e: any) {
            console.error("Balance fetch failed", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/wallet/transfer { from, to, amount, type: 'wara'|'eth' }
    router.post('/transfer', async (req: Request, res: Response) => {
        const { from, to, amount, type, password } = req.body;
        if (!from || !to || !amount) return res.status(400).json({ error: 'Missing fields' });

        try {
            // 1. Get User's Wallet (Requires decryping PK with password)
            // If the user is logged in, they provide their password for this sensitive action.
            const wallet = await node.identity.getLocalUserWallet(from, password);
            if (!wallet) return res.status(401).json({ error: 'Auth failed: check password' });
            const signer = wallet.connect(node.blockchain.provider);

            let tx;
            if (type === 'eth') {
                tx = await signer.sendTransaction({
                    to,
                    value: ethers.parseEther(amount)
                });
            } else {
                const tokenContract = node.blockchain.token!.connect(signer) as ethers.Contract;
                tx = await tokenContract.transfer(to, ethers.parseUnits(amount, 18));
            }

            await tx.wait();
            res.json({ success: true, txHash: tx.hash });
        } catch (e: any) {
            console.error("Transfer failed", e);
            res.status(500).json({ error: e.message });
        }
    });

    //CLAIM PROFF

    // POST /api/wallet/claim-rewards (Batch Process Local Proofs)
    router.post('/claim-rewards', async (req: Request, res: Response) => {
        const { wallet: walletAddress, password } = req.body;
        if (!walletAddress) return res.status(400).json({ error: 'Missing wallet address' });

        try {
            // 1. Authenticate & Get Signer
            let signer = node.identity.getAuthenticatedSigner(req);
            // Fallback: If no session, try explicit auth with password
            if (!signer && walletAddress && password) {
                signer = await node.identity.getLocalUserWallet(walletAddress, password);
            }
            if (!signer) return res.status(401).json({ error: 'Authentication failed' });

            // 1.1 SYNC REMOTE PROOFS (Unified Claim)
            // --------------------------------------
            try {
                // Find all remote nodes associated with this user
                let remoteNodes: any[] = [];

                // Try loading from saved nodes file (simple persistence)
                const savedNodesPath = path.join(CONFIG.DATA_DIR, 'saved_remote_nodes.json');
                if (fs.existsSync(savedNodesPath)) {
                    const saved = JSON.parse(fs.readFileSync(savedNodesPath, 'utf-8'));
                    if (Array.isArray(saved)) remoteNodes = saved;
                }

                // --- REAL DB LOGIC (Override) ---
                try {
                    const userProfile = await node.prisma.localProfile.findFirst({
                        where: { walletAddress: signer.address },
                        include: { remoteNodes: true }
                    });
                    if (userProfile && userProfile.remoteNodes.length > 0) {
                        remoteNodes = userProfile.remoteNodes;
                    }
                } catch (dbErr) { console.warn("DB remote node fetch failed", dbErr); }
                // --------------------------------


                if (remoteNodes.length > 0) {
                    console.log(`[Wallet] Syncing proofs from ${remoteNodes.length} remote nodes...`);
                    const proofsDir = path.join(CONFIG.DATA_DIR, 'proofs');
                    if (!fs.existsSync(proofsDir)) fs.mkdirSync(proofsDir);

                    for (const rNode of remoteNodes) {
                        try {
                            let adminKey = '';
                            if (rNode.encryptedKey) {
                                try { adminKey = decryptPayload(rNode.encryptedKey, password); }
                                catch (e) { console.warn(`[Wallet] Key decrypt fail for ${rNode.url}`); continue; }
                            }
                            // If no key (local-only or public), we might fail auth on remote, but try anyway?
                            // No, secure export requires Auth.
                            if (!adminKey) continue;

                            const exportUrl = `${rNode.url}/api/wallet/export-proofs?wallet=${signer.address}`;
                            const resp = await axios.get(exportUrl, { headers: { 'X-Wara-Key': adminKey } });

                            if (resp.status !== 200) continue;

                            const { proofs } = resp.data;
                            if (Array.isArray(proofs) && proofs.length > 0) {
                                console.log(`[Wallet] Downloaded ${proofs.length} proofs from ${rNode.url}`);

                                // Save locally
                                const importedFilenames: string[] = [];
                                for (const p of proofs) {
                                    const fname = `imported_${Date.now()}_${Math.random().toString(36).substring(7)}.json`;
                                    const fpath = path.join(proofsDir, fname);
                                    fs.writeFileSync(fpath, JSON.stringify(p));
                                    importedFilenames.push(p._filename); // Original filename for deleting
                                }

                                // Delete from remote to avoid double processing
                                await axios.post(`${rNode.url}/admin/proofs/delete`,
                                    { filenames: importedFilenames },
                                    { headers: { 'X-Wara-Key': adminKey } }
                                );
                            }

                        } catch (e) { console.warn(`Failed to sync ${rNode.url}`, e); }
                    }
                }
            } catch (e) { console.error("Remote Sync Failed", e); }


            // Ensure signer is connected to provider
            if (!signer.provider) {
                signer = signer.connect(node.blockchain.provider);
            }

            // 2. Scan for Proofs
            const proofsDir = path.join(CONFIG.DATA_DIR, 'proofs');
            if (!fs.existsSync(proofsDir)) return res.json({ success: true, claimed: 0, message: "No proofs found" });

            const files = fs.readdirSync(proofsDir).filter(f => f.endsWith('.json'));

            const adBatch = {
                campaignIds: [] as number[],
                viewers: [] as string[],
                contentHashes: [] as string[],
                linkIds: [] as string[],
                signatures: [] as string[],
                filenames: [] as string[]
            };

            const premiumBatch = {
                hosters: [] as string[],
                viewers: [] as string[],
                contentHashes: [] as string[],
                nonces: [] as any[],
                signatures: [] as string[],
                filenames: [] as string[]
            };

            // 3. Filter & Prepare Batches
            for (const file of files) {
                try {
                    const content = fs.readFileSync(path.join(proofsDir, file), 'utf-8');
                    const proof = JSON.parse(content);

                    // Use the uploaderWallet or hoster in the JSON as a hint for filtering
                    const targetUploader = (proof.uploaderWallet || proof.hoster || "").toLowerCase();
                    if (targetUploader === signer.address.toLowerCase()) {

                        if (proof.type === 'premium' || proof.type === 'premium_view') {
                            premiumBatch.hosters.push(proof.hoster || proof.uploaderWallet);
                            premiumBatch.viewers.push(proof.viewer || proof.viewerAddress);
                            premiumBatch.contentHashes.push(proof.contentHash || ethers.ZeroHash);
                            premiumBatch.nonces.push(proof.nonce || 0);
                            premiumBatch.signatures.push(proof.signature);
                            premiumBatch.filenames.push(file);
                        } else {
                            // Default to Ad Proof
                            // FIX: Validate LinkID format
                            if (!proof.linkId || !proof.linkId.startsWith('0x') || proof.linkId.length !== 66) {
                                console.warn(`[Wallet] Skipping ad proof with invalid LinkID format: ${file} `);
                                continue;
                            }

                            const hexContentHash = (proof.contentHash && proof.contentHash.startsWith('0x')) ? proof.contentHash : (proof.contentHash ? `0x${proof.contentHash}` : ethers.ZeroHash);
                            adBatch.campaignIds.push(proof.campaignId);
                            adBatch.viewers.push(proof.viewerAddress);
                            adBatch.contentHashes.push(hexContentHash);
                            adBatch.linkIds.push(proof.linkId);
                            adBatch.signatures.push(proof.signature);
                            adBatch.filenames.push(file);
                        }
                    }
                } catch (e) {
                    console.error(`Skipping invalid proof ${file}`, e);
                }
            }

            let results = { ads: 0, premium: 0, txs: [] as string[] };

            // 4. Process Ad Batch
            if (adBatch.campaignIds.length > 0) {
                console.log(`[Wallet] Claiming ${adBatch.campaignIds.length} ad rewards...`);
                const adContract = node.blockchain.adManager!.connect(signer) as ethers.Contract;

                try {
                    const tx = await adContract.batchClaimAdView(adBatch.campaignIds, adBatch.viewers, adBatch.contentHashes, adBatch.linkIds, adBatch.signatures);
                    await tx.wait();
                    results.ads = adBatch.campaignIds.length;
                    results.txs.push(tx.hash);

                    // Archive files on success
                    const archiveDir = path.join(CONFIG.DATA_DIR, 'archive');
                    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir);
                    for (const file of adBatch.filenames) {
                        try {
                            fs.renameSync(path.join(proofsDir, file), path.join(archiveDir, file));
                        } catch (e) { }
                    }

                } catch (e: any) {
                    console.error("❌ Batch Ad Claim FAILED:", e.shortMessage || e.message);
                }
            }

            // 5. Process Premium Batch
            if (premiumBatch.hosters.length > 0) {
                console.log(`[Wallet] Claiming ${premiumBatch.hosters.length} premium rewards...`);
                const subContract = node.blockchain.subscriptions!.connect(signer) as ethers.Contract;

                try {
                    const tx = await subContract.recordPremiumViewBatch(
                        premiumBatch.hosters,
                        premiumBatch.viewers,
                        premiumBatch.contentHashes,
                        premiumBatch.nonces,
                        premiumBatch.signatures
                    );
                    await tx.wait();

                    results.premium = premiumBatch.filenames.length;
                    results.txs.push(tx.hash);

                    // Archive premium proofs
                    const archiveDir = path.join(CONFIG.DATA_DIR, 'archive');
                    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir);
                    for (const file of premiumBatch.filenames) {
                        try {
                            fs.renameSync(path.join(proofsDir, file), path.join(archiveDir, file));
                        } catch (e) { }
                    }
                } catch (e: any) {
                    console.error("❌ Batch Premium Claim FAILED:", e.shortMessage || e.message);
                }
            }

            res.json({ success: true, ...results });

        } catch (e: any) {
            console.error("Claim rewards failed", e);
            // Detect revert reason?
            res.status(500).json({ error: e.message || "Msg failed" });
        }
    });

    // POST /api/wallet/claim-vote-rewards (Batch Process Pending Votes from Disk)
    router.post('/claim-vote-rewards', async (req: Request, res: Response) => {
        const { wallet: walletAddress, password } = req.body;
        if (!walletAddress) return res.status(400).json({ error: 'Missing wallet address' });

        try {
            // 1. Authenticate
            const wallet = await node.identity.getLocalUserWallet(walletAddress, password);
            if (!wallet) return res.status(401).json({ error: 'Authentication failed' });

            const provider = node.blockchain.provider;
            const signer = wallet.connect(provider);

            // 1.1 SYNC REMOTE VOTES (Unified Governor)
            try {
                const userProfile = await node.prisma.localProfile.findFirst({
                    where: { walletAddress: signer.address },
                    include: { remoteNodes: true }
                });

                if (userProfile && userProfile.remoteNodes.length > 0) {
                    console.log(`[Wallet] Syncing votes from ${userProfile.remoteNodes.length} remote nodes...`);
                    const votesDir = path.join(CONFIG.DATA_DIR, 'votes');
                    if (!fs.existsSync(votesDir)) fs.mkdirSync(votesDir);

                    for (const rNode of userProfile.remoteNodes) {
                        try {
                            let adminKey = '';
                            if (rNode.encryptedKey) {
                                try { adminKey = decryptPayload(rNode.encryptedKey, password); }
                                catch (e) { console.warn(`[Wallet] Key decrypt fail for ${rNode.url}`); continue; }
                            }
                            if (!adminKey) continue;

                            const exportUrl = `${rNode.url}/api/wallet/export-votes?wallet=${signer.address}`;
                            const resp = await axios.get(exportUrl, { headers: { 'X-Wara-Key': adminKey } });
                            if (resp.status !== 200) continue;

                            const { votes } = resp.data;
                            if (Array.isArray(votes) && votes.length > 0) {
                                console.log(`[Wallet] Downloaded ${votes.length} votes from ${rNode.url} `);
                                const importedFilenames: string[] = [];
                                for (const v of votes) {
                                    const fname = `imported_vote_${Date.now()}_${Math.random().toString(36).substring(7)}.json`;
                                    fs.writeFileSync(path.join(votesDir, fname), JSON.stringify(v));
                                    importedFilenames.push(v._filename);
                                }

                                await axios.post(`${rNode.url}/admin/votes/delete`,
                                    { filenames: importedFilenames },
                                    { headers: { 'X-Wara-Key': adminKey } }
                                );
                            }
                        } catch (e) { console.warn(`Failed to sync votes from ${rNode.url}`, e); }
                    }
                }
            } catch (e) { console.error("Remote Vote Sync Failed", e); }

            // 2. Scan for Signed Votes
            const votesDir = path.join(CONFIG.DATA_DIR, 'votes');
            if (!fs.existsSync(votesDir)) return res.json({ success: true, submitted: 0, message: "No pending votes" });

            const files = fs.readdirSync(votesDir).filter(f => f.endsWith('.json'));

            const batch = {
                linkIds: [] as string[],
                contentHashes: [] as string[],
                values: [] as number[],
                voters: [] as string[],
                nonces: [] as number[],
                timestamps: [] as number[],
                signatures: [] as string[],
                filenames: [] as string[]
            };

            // 3. Prepare Batch
            for (const file of files) {
                try {
                    const content = fs.readFileSync(path.join(votesDir, file), 'utf-8');
                    const v = JSON.parse(content);

                    // Required fields check
                    if (!v.linkId || !v.contentHash || !v.signature) continue;

                    // Derive On-Chain Link ID from plain string ID (Prisma ID)
                    const onChainLinkId = ethers.solidityPackedKeccak256(["string"], [v.linkId]);
                    const hexContentHash = v.contentHash.startsWith('0x') ? v.contentHash : `0x${v.contentHash}`;

                    batch.linkIds.push(onChainLinkId);
                    batch.contentHashes.push(hexContentHash);
                    batch.values.push(v.voteValue);
                    batch.voters.push(v.voter);
                    batch.nonces.push(v.nonce || 0);
                    batch.timestamps.push(v.timestamp || Math.floor(Date.now() / 1000));
                    batch.signatures.push(v.signature);
                    batch.filenames.push(file);

                } catch (e) {
                    console.error(`Skipping invalid vote file ${file}`, e);
                }
            }

            if (batch.linkIds.length === 0) {
                return res.json({ success: true, submitted: 0, message: "No valid votes to process" });
            }

            console.log(`[Wallet] Batch processing ${batch.linkIds.length} votes...`);

            // 4. Send Batch Transaction
            const contract = node.blockchain.linkRegistry!.connect(signer) as ethers.Contract;

            const tx = await contract.batchVoteWithSignature(
                batch.linkIds,
                batch.contentHashes,
                batch.values,
                batch.voters,
                batch.nonces,
                batch.timestamps,
                batch.signatures
            );

            console.log(`[Wallet] Batch Vote TX sent: ${tx.hash}`);
            await tx.wait();

            // 5. Delete Processed Files
            let deleted = 0;
            for (const f of batch.filenames) {
                try {
                    fs.unlinkSync(path.join(votesDir, f));
                    deleted++;
                } catch (e) { }
            }

            res.json({ success: true, submitted: deleted, txHash: tx.hash });
        } catch (e: any) {
            console.error("Claim vote rewards failed", e);
            res.status(500).json({ error: e.message });
        }
    });

    //EXPORT PROFF

    // GET /api/wallet/export-proofs (For remote syncing - Protected)
    router.get('/export-proofs', node.identity.requireAuth, async (req: Request, res: Response) => {
        try {
            const { wallet } = req.query;
            if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

            const targetWallet = (wallet as string).toLowerCase();
            const proofsDir = path.join(CONFIG.DATA_DIR, 'proofs');

            if (!fs.existsSync(proofsDir)) return res.json({ proofs: [] });

            const files = fs.readdirSync(proofsDir).filter(f => f.endsWith('.json'));
            const proofs = [];

            for (const f of files) {
                try {
                    const content = fs.readFileSync(path.join(proofsDir, f), 'utf-8');
                    const p = JSON.parse(content);
                    if (p.uploaderWallet && p.uploaderWallet.toLowerCase() === targetWallet) {
                        proofs.push({ ...p, _filename: f });
                    }
                } catch (e) { }
            }

            res.json({ proofs });

        } catch (e: any) {
            console.error("Export Proofs Failed", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/wallet/export-votes (Remote Sync)
    router.get('/export-votes', node.identity.requireAuth, async (req: Request, res: Response) => {
        try {
            const { wallet } = req.query; // Filter by voter wallet
            if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

            const votesDir = path.join(CONFIG.DATA_DIR, 'votes');
            if (!fs.existsSync(votesDir)) return res.json({ votes: [] });

            const files = fs.readdirSync(votesDir).filter(f => f.endsWith('.json'));
            const votes = [];

            for (const f of files) {
                try {
                    const content = JSON.parse(fs.readFileSync(path.join(votesDir, f), 'utf-8'));
                    // Check if voter matches requested wallet
                    if (content.voter && content.voter.toLowerCase() === String(wallet).toLowerCase()) {
                        votes.push({ ...content, _filename: f });
                    }
                } catch (e) { }
            }
            res.json({ votes });
        } catch (e: any) {
            console.error("Export Votes Failed", e);
            res.status(500).json({ error: e.message });
        }
    });

    //PROFILE PREFERENCES

    // GET /api/wallet/preferences
    router.get('/preferences', async (req: Request, res: Response) => {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });
        try {
            const profile = await node.prisma.localProfile.findUnique({ where: { id: String(userId) }, select: { preferredLanguage: true } });
            res.json(profile || { preferredLanguage: 'es' });
        } catch (e) {
            res.status(500).json({ error: 'Failed to fetch preferences' });
        }
    });

    // POST /api/wallet/preferences
    router.post('/preferences', async (req: Request, res: Response) => {
        const { userId, preferredLanguage } = req.body;
        if (!userId || !preferredLanguage) return res.status(400).json({ error: 'Missing parameters' });
        try {
            await node.prisma.localProfile.update({ where: { id: String(userId) }, data: { preferredLanguage: String(preferredLanguage) } });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Failed to save preferences' });
        }
    });

    return router;

};
