import { Express, Request, Response } from 'express';
import { WaraNode } from '../node'; // Assuming node.ts is in parent dir

export const setupWalletRoutes = (app: Express, node: WaraNode) => {

    // ==========================================
    // WALLET & BLOCKCHAIN API
    // ==========================================

    // GET /api/wallet/balances?address=0x... (Legacy - public)
    app.get('/api/wallet/balances', async (req: Request, res: Response) => {
        const { address } = req.query;
        if (!address) return res.status(400).json({ error: 'Missing address' });

        try {
            const { ethers } = await import('ethers');
            const { ERC20_ABI, WARA_TOKEN_ADDRESS } = await import('../contracts');

            // Normalize address - try to fix checksum, fallback to original
            let normalizedAddress: string;
            try {
                normalizedAddress = ethers.getAddress(address as string);
            } catch (e) {
                // If checksum validation fails, use address as-is (ethers will handle it)
                normalizedAddress = (address as string).toLowerCase();
            }

            const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

            // ETH Balance
            const ethBal = await provider.getBalance(normalizedAddress);

            // WARA Balance
            const tokenContract = new ethers.Contract(WARA_TOKEN_ADDRESS, ERC20_ABI, provider);
            const waraBal = await tokenContract.balanceOf(normalizedAddress);

            res.json({
                eth: ethers.formatEther(ethBal),
                wara: ethers.formatUnits(waraBal, 18),
                waraAddress: WARA_TOKEN_ADDRESS
            });
        } catch (e: any) {
            console.error("Balance fetch failed", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/wallet/my-balances?userId=xxx (Secure - uses DB)
    app.get('/api/wallet/my-balances', async (req: Request, res: Response) => {
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

            const { ethers } = await import('ethers');
            const { ERC20_ABI, WARA_TOKEN_ADDRESS } = await import('../contracts');

            const rpcUrl = process.env.RPC_URL;
            const provider = new ethers.JsonRpcProvider(rpcUrl);

            let ethBal = BigInt(0);
            let waraBal = BigInt(0);

            try {
                // Timeout-like check (getBalance is async)
                ethBal = await provider.getBalance(profile.walletAddress);

                const tokenContract = new ethers.Contract(WARA_TOKEN_ADDRESS, ERC20_ABI, provider);
                waraBal = await tokenContract.balanceOf(profile.walletAddress);
            } catch (rpcError) {
                console.warn(`[WaraNode] Blockchain RPC Unreachable at ${rpcUrl}. Returning 0 balances.`);
            }

            res.json({
                eth: ethers.formatEther(ethBal),
                wara: ethers.formatUnits(waraBal, 18),
                waraAddress: WARA_TOKEN_ADDRESS,
                address: profile.walletAddress
            });
        } catch (e: any) {
            console.error("Balance fetch failed", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/wallet/transfer { from, to, amount, type: 'wara'|'eth' }
    app.post('/api/wallet/transfer', async (req: Request, res: Response) => {
        const { from, to, amount, type, password } = req.body;
        if (!from || !to || !amount) return res.status(400).json({ error: 'Missing fields' });

        try {
            const { ethers } = await import('ethers');
            const { ERC20_ABI, WARA_TOKEN_ADDRESS } = await import('../contracts');
            // const { getLocalUserWallet } = await import('./node'); // Removed import

            // 1. Get User's Wallet (Requires decryping PK with password)
            // If the user is logged in, they provide their password for this sensitive action.
            const wallet = await node.getLocalUserWallet(from, password);
            const signer = wallet.connect(new ethers.JsonRpcProvider(process.env.RPC_URL));

            let tx;
            if (type === 'eth') {
                tx = await signer.sendTransaction({
                    to,
                    value: ethers.parseEther(amount)
                });
            } else {
                const tokenContract = new ethers.Contract(WARA_TOKEN_ADDRESS, [
                    "function transfer(address to, uint256 amount) returns (bool)"
                ], signer);
                tx = await tokenContract.transfer(to, ethers.parseUnits(amount, 18));
            }

            await tx.wait();
            res.json({ success: true, txHash: tx.hash });
        } catch (e: any) {
            console.error("Transfer failed", e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/wallet/claim-rewards (Batch Process Local Proofs)
    app.post('/api/wallet/claim-rewards', async (req: Request, res: Response) => {
        const { wallet: walletAddress, password } = req.body;
        if (!walletAddress) return res.status(400).json({ error: 'Missing wallet address' });

        try {
            const { ethers } = await import('ethers');
            const { AD_MANAGER_ADDRESS, AD_MANAGER_ABI } = await import('../contracts');
            const fs = await import('fs');
            const path = await import('path');
            const fetch = require('node-fetch'); // Ensure fetch available

            // 1. Authenticate & Get Signer
            let signer = node.getAuthenticatedSigner(req);
            // Fallback: If no session, try explicit auth with password
            if (!signer && walletAddress && password) {
                signer = await node.getLocalUserWallet(walletAddress, password);
            }
            if (!signer) return res.status(401).json({ error: 'Authentication failed' });

            // 1.1 SYNC REMOTE PROOFS (Unified Claim)
            // --------------------------------------
            try {
                // Find all remote nodes associated with this user
                // We use the LocalProfile store or saved remote nodes
                const { decryptPayload } = await import('../encryption'); // Utility

                // We assume user tracks remote nodes in DB or localStorage-synced JSON
                // Since this is backend, we check 'remote_nodes.json' if it exists or Prisma
                const userId = req.headers['x-user-id']; // Optional hint
                let remoteNodes: any[] = [];

                // Try loading from saved nodes file (simple persistence)
                const savedNodesPath = path.join(node.dataDir, 'saved_remote_nodes.json');
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
                    const proofsDir = path.join(node.dataDir, 'proofs');
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
                            const resp = await fetch(exportUrl, { headers: { 'X-Wara-Key': adminKey } });

                            if (!resp.ok) continue;

                            const { proofs } = await resp.json();
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
                                await fetch(`${rNode.url}/admin/proofs/delete`, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'X-Wara-Key': adminKey
                                    },
                                    body: JSON.stringify({ filenames: importedFilenames })
                                });
                            }

                        } catch (e) { console.warn(`Failed to sync ${rNode.url}`, e); }
                    }
                }
            } catch (e) { console.error("Remote Sync Failed", e); }


            // Ensure signer is connected to provider
            if (!signer.provider) {
                signer = signer.connect(node.provider);
            }
            const contract = new ethers.Contract(AD_MANAGER_ADDRESS, AD_MANAGER_ABI, signer);
            // const contract = new ethers.Contract(AD_MANAGER_ADDRESS, AD_MANAGER_ABI, signer); // No longer needed directly here

            // 2. Scan for Proofs
            const proofsDir = path.join(node.dataDir, 'proofs');
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

            const { SUBSCRIPTION_ADDRESS, SUBSCRIPTIONS_ABI } = await import('../contracts');

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
                                console.warn(`[Wallet] Skipping ad proof with invalid LinkID format: ${file}`);
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
                // Use the ABI we just updated in contracts.ts
                const adContract = new ethers.Contract(AD_MANAGER_ADDRESS, AD_MANAGER_ABI, signer);

                try {
                    const tx = await adContract.batchClaimAdView(adBatch.campaignIds, adBatch.viewers, adBatch.contentHashes, adBatch.linkIds, adBatch.signatures);
                    await tx.wait();
                    results.ads = adBatch.campaignIds.length;
                    results.txs.push(tx.hash);

                    // Archive files on success
                    const archiveDir = path.join(node.dataDir, 'archive');
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
                const subContract = new ethers.Contract(SUBSCRIPTION_ADDRESS, SUBSCRIPTIONS_ABI, signer);

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
                    const archiveDir = path.join(node.dataDir, 'archive');
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
    app.post('/api/wallet/claim-vote-rewards', async (req: Request, res: Response) => {
        const { wallet: walletAddress, password } = req.body;
        if (!walletAddress) return res.status(400).json({ error: 'Missing wallet address' });

        try {
            const { ethers } = await import('ethers');
            const { LINK_REGISTRY_ADDRESS } = await import('../contracts');
            const fs = await import('fs');
            const path = await import('path');

            // 1. Authenticate
            const wallet = await node.getLocalUserWallet(walletAddress, password);
            if (!wallet) return res.status(401).json({ error: 'Authentication failed' });

            const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
            const signer = wallet.connect(provider);

            // 1.1 SYNC REMOTE VOTES (Unified Governor)
            try {
                const { decryptPayload } = await import('../encryption');
                const userProfile = await node.prisma.localProfile.findFirst({
                    where: { walletAddress: signer.address },
                    include: { remoteNodes: true }
                });

                if (userProfile && userProfile.remoteNodes.length > 0) {
                    console.log(`[Wallet] Syncing votes from ${userProfile.remoteNodes.length} remote nodes...`);
                    const votesDir = path.join(node.dataDir, 'votes');
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
                            const resp = await fetch(exportUrl, { headers: { 'X-Wara-Key': adminKey } });
                            if (!resp.ok) continue;

                            const { votes } = await resp.json();
                            if (Array.isArray(votes) && votes.length > 0) {
                                console.log(`[Wallet] Downloaded ${votes.length} votes from ${rNode.url}`);
                                const importedFilenames: string[] = [];
                                for (const v of votes) {
                                    const fname = `imported_vote_${Date.now()}_${Math.random().toString(36).substring(7)}.json`;
                                    fs.writeFileSync(path.join(votesDir, fname), JSON.stringify(v));
                                    importedFilenames.push(v._filename);
                                }

                                await fetch(`${rNode.url}/admin/votes/delete`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'X-Wara-Key': adminKey },
                                    body: JSON.stringify({ filenames: importedFilenames })
                                });
                            }
                        } catch (e) { console.warn(`Failed to sync votes from ${rNode.url}`, e); }
                    }
                }
            } catch (e) { console.error("Remote Vote Sync Failed", e); }

            // 2. Scan for Signed Votes
            const votesDir = path.join(node.dataDir, 'votes');
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
            const abi = [
                "function batchVoteWithSignature(bytes32[] linkIds, bytes32[] contentHashes, int8[] values, address[] voters, uint256[] nonces, uint256[] timestamps, bytes[] signatures) external"
            ];
            const contract = new ethers.Contract(LINK_REGISTRY_ADDRESS, abi, signer);

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

    // GET /api/wallet/export-proofs (For remote syncing - Protected)
    app.get('/api/wallet/export-proofs', node.requireAuth, async (req: Request, res: Response) => {
        try {
            const { wallet } = req.query;
            if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

            const targetWallet = (wallet as string).toLowerCase();

            // Just read proofs from disk safely
            const fs = await import('fs');
            const path = await import('path');
            const proofsDir = path.join(node.dataDir, 'proofs');

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
    app.get('/api/wallet/export-votes', node.requireAuth, async (req: Request, res: Response) => {
        try {
            const { wallet } = req.query; // Filter by voter wallet
            if (!wallet) return res.status(400).json({ error: 'Missing wallet' });

            const fs = await import('fs');
            const path = await import('path');
            const votesDir = path.join(node.dataDir, 'votes');
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

};
