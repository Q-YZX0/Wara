import { Router, Request, Response } from 'express';
import { App } from '../App';
import { ethers } from 'ethers';
import { decryptPayload, verifyPassword, decryptPrivateKey, encryptPayload } from '../utils/encryption';
import { randomUUID } from 'crypto';

export const setupAuthRoutes = (node: App) => {
    const router = Router();
    // POST /api/auth/register
    router.post('/register', async (req: Request, res: Response) => {
        const { username, password, privateKey } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

        try {
            const { hashPassword, encryptPrivateKey } = await import('../utils/encryption');
            const existing = await node.prisma.localProfile.findUnique({ where: { username } });
            if (existing) return res.status(400).json({ error: 'Username taken' });

            let wallet;
            if (privateKey) {
                try {
                    wallet = new ethers.Wallet(privateKey);
                } catch (e) {
                    return res.status(400).json({ error: 'Invalid private key format' });
                }
            } else {
                wallet = ethers.Wallet.createRandom();
            }

            const existingWallet = await node.prisma.localProfile.findFirst({ where: { walletAddress: wallet.address } });
            if (existingWallet) return res.status(400).json({ error: 'This wallet is already registered to another user' });

            const encryptedPrivateKey = encryptPrivateKey(wallet.privateKey, password);
            const passwordHash = hashPassword(password);

            const profile = await node.prisma.localProfile.create({
                data: {
                    username,
                    passwordHash,
                    encryptedPrivateKey,
                    walletAddress: wallet.address
                }
            });

            res.json({ success: true, walletAddress: profile.walletAddress });
        } catch (e) {
            console.error("[Auth] Registration failed:", e);
            res.status(500).json({ error: 'Registration failed' });
        }
    });

    // POST /api/auth/login
    router.post('/login', async (req: Request, res: Response) => {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
        try {
            const { verifyPassword, decryptPrivateKey } = await import('../utils/encryption');

            const profile = await node.prisma.localProfile.findUnique({ where: { username } }); // Public prisma
            if (!profile || !verifyPassword(password, profile.passwordHash)) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            // Generate Session Token
            const authToken = randomUUID();
            node.identity.userSessions.set(authToken, profile.username); // Public userSessions

            // Unlock Wallet for Session
            try {
                const decryptedKey = decryptPrivateKey(profile.encryptedPrivateKey, password);
                const sessionWallet = new ethers.Wallet(decryptedKey, node.blockchain.provider);
                node.identity.activeWallets.set(authToken, sessionWallet); // Public activeWallets
                console.log(`[Auth] Wallet unlocked for session ${authToken.substring(0, 8)}...`);
            } catch (err) {
                console.error("Failed to unlock wallet for session");
            }

            res.json({
                success: true,
                id: profile.id,
                walletAddress: profile.walletAddress,
                username: profile.username,
                authToken
            });
        } catch (e) {
            res.status(500).json({ error: 'Login failed' });
        }
    });

    // POST /api/auth/sign-ad-proof (Local Signing for Ads with Hashing)
    router.post('/sign-ad-proof', async (req: Request, res: Response) => {
        const { authToken, campaignId, viewer, contentHash, linkId } = req.body;
        if (!authToken || !campaignId || !viewer || !contentHash || !linkId) {
            return res.status(400).json({ error: 'Missing ad proof data' });
        }

        // 1. Verify Session
        const username = node.identity.userSessions.get(authToken);
        if (!username) return res.status(401).json({ error: 'Invalid session' });

        // 2. Get Unlocked Wallet
        const wallet = node.identity.activeWallets.get(authToken);
        if (!wallet) return res.status(401).json({ error: 'Wallet locked. Re-login required.' });

        try {
            // 3. Construct Hash (Solidity Compatible)
            const onChainLinkId = ethers.id(linkId); // Keccak256 of string
            const ch = contentHash.startsWith('0x') ? contentHash : `0x${contentHash}`;

            // REMOVED 'uploader' from hash to avoid frontend/backend synchronization issues on ownership
            const messageHash = ethers.solidityPackedKeccak256(
                ["uint256", "address", "bytes32", "bytes32"],
                [campaignId, viewer, ch, onChainLinkId]
            );

            // 4. Sign the BINARY hash
            // ethers.verifyMessage(ethers.getBytes(hash), sig) works if we sign bytes.
            const signature = await wallet.signMessage(ethers.getBytes(messageHash));

            res.json({
                success: true,
                signature,
                address: wallet.address
            });
        } catch (e: any) {
            console.error("Ad Signing failed:", e);
            res.status(500).json({ error: 'Ad Signing failed: ' + e.message });
        }
    });

    // GET /api/auth/session
    router.get('/session', node.identity.requireAuth, async (req: Request, res: Response) => {
        // If we reach here, requireAuth middleware has already validated the session
        // and attached user and wallet to req.
        const username = (req as any).user.username;
        const walletAddress = (req as any).user.walletAddress;
        const authToken = req.headers['x-auth-token'] as string;

        res.json({
            success: true,
            username,
            walletAddress,
            authToken
        });
    });

    // POST /api/auth/import-profile (Encrypted with NodeKey)
    router.post('/import-profile', async (req: Request, res: Response) => {
        const { payload } = req.body;
        if (!payload) return res.status(400).json({ error: 'Missing encrypted payload' });

        try {
            // Decrypt using ADMIN KEY (Node Secret)
            const data = decryptPayload(payload, node.adminKey);

            // Gatekeeper: Validate Timestamp (Prevent Replay)
            const now = Date.now();
            if (!data.timestamp || Math.abs(now - data.timestamp) > 60000 * 5) { // 5 mins tolerance
                return res.status(401).json({ error: 'Invalid or expired timestamp' });
            }

            // Upsert Profile
            const { username, passwordHash, encryptedPrivateKey, walletAddress } = data;

            await node.prisma.localProfile.upsert({
                where: { username },
                update: { passwordHash, encryptedPrivateKey, walletAddress },
                create: { username, passwordHash, encryptedPrivateKey, walletAddress }
            });

            console.log(`[Auth] Remote profile import/sync for user: ${username}`);
            res.json({ success: true });

        } catch (e) {
            console.error("Profile import failed", e);
            res.status(401).json({ error: 'Decryption failed or invalid key' });
        }
    });

    // POST /api/auth/remote-login (Encrypted credentials)
    router.post('/remote-login', async (req: Request, res: Response) => {
        const { payload } = req.body;
        if (!payload) return res.status(400).json({ error: 'Missing encrypted payload' });

        try {
            // Decrypt
            const data = decryptPayload(payload, node.adminKey);

            // Gatekeeper
            const now = Date.now();
            if (!data.timestamp || Math.abs(now - data.timestamp) > 60000 * 5) {
                return res.status(401).json({ error: 'Invalid or expired timestamp' });
            }

            const { username, password } = data;

            // Logic Copied from Login
            const profile = await node.prisma.localProfile.findUnique({ where: { username } });
            if (!profile || !verifyPassword(password, profile.passwordHash)) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const authToken = randomUUID();
            node.identity.userSessions.set(authToken, profile.username);

            try {
                const decryptedKey = decryptPrivateKey(profile.encryptedPrivateKey, password);
                const sessionWallet = new ethers.Wallet(decryptedKey, node.blockchain.provider);
                node.identity.activeWallets.set(authToken, sessionWallet);
                console.log(`[Auth] Remote Wallet unlocked for user ${username}`);
            } catch (err) {
                console.error("Failed to unlock remote wallet");
            }

            res.json({
                success: true,
                id: profile.id,
                walletAddress: profile.walletAddress,
                username: profile.username,
                authToken
            });

        } catch (e) {
            console.error("Remote login failed", e);
            res.status(401).json({ error: 'Unauthorized' });
        }
    });

    // POST /api/auth/prepare-sync-payloads (Generate Auth Blobs for Remote Node)
    router.post('/prepare-sync-payloads', async (req: Request, res: Response) => {
        const { targetUrl, password } = req.body;
        if (!targetUrl || !password) return res.status(400).json({ error: 'Missing targetUrl or password' });

        try {
            // 1. Authenticate Local User (Password Check)
            // Ideally we check req.user via session, but for sensitive action repeat password is good.
            // Or we just find the user that matches this password.
            // Since this is a local tool, we assume Single User for now or find by password match.
            // BETTER: Find the user linked to this wallet/session?
            // Fallback: Check if password works for ANY profile (since we don't send username)
            // But wara-node is multi-user capable? LocalProfile table implies yes.
            // Let's assume the Dashboard context sends the Username via session?
            // "req.body" has password.
            // Let's iterate all profiles to find which one matches password? Inefficient.
            // The dashboard SHOULD send the username too.
            // Let's UPDATE req.body to include username or require session auth middleware?
            // Let's Require Session Auth via Header 'x-auth-token'

            const authToken = req.headers['x-auth-token'] as string;
            let username = node.identity.userSessions.get(authToken);

            // If no session, try to infer from password? No.
            // Frontend MUST send Token.
            if (!username) return res.status(401).json({ error: 'Local Session required' });

            const profile = await node.prisma.localProfile.findUnique({ where: { username } });
            if (!profile || !verifyPassword(password, profile.passwordHash)) {
                return res.status(401).json({ error: 'Invalid password' });
            }

            // 2. Find Remote Node Config (Encrypted Key)
            // We need to match targetUrl to a stored RemoteNode
            const remoteNode = await node.prisma.remoteNode.findFirst({
                where: {
                    userId: profile.id,
                    url: targetUrl
                }
            });

            if (!remoteNode || !remoteNode.encryptedKey) {
                return res.status(404).json({ error: 'Remote node not found or key missing in DB' });
            }

            // 3. Decrypt Remote Admin Key
            const remoteAdminKey = decryptPayload(remoteNode.encryptedKey, password);

            // 4. Generate Import Payload (For Sync)
            const importData = {
                username: profile.username,
                passwordHash: profile.passwordHash,
                encryptedPrivateKey: profile.encryptedPrivateKey,
                walletAddress: profile.walletAddress,
                timestamp: Date.now()
            };
            const importPayload = encryptPayload(importData, remoteAdminKey);

            // 5. Generate Login Payload (For Auth)
            // Remote Login expects: { username, password, timestamp }
            // Note: We are sending the RAW password inside the encrypted blob. 
            // This is safe because it is encrypted with the Remote Admin Key (AES-256-GCM).
            const loginData = {
                username: profile.username,
                password, // Raw password needed because Remote Node verifies hash
                timestamp: Date.now()
            };
            const loginPayload = encryptPayload(loginData, remoteAdminKey);

            res.json({ success: true, importPayload, loginPayload });

        } catch (e: any) {
            console.error("Payload gen failed", e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};

