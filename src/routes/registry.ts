import { Router, Request, Response } from 'express';
import { App } from '../App';
import * as path from 'path';
import * as fs from 'fs';
import { CONFIG } from '../config/config';
import { ethers } from 'ethers';

export const setupRegistryRoutes = (node: App) => {
    const router = Router();
    // --- Blockchain Identity Endpoints (Muggi Registry) ---

    // POST /api/registry/register
    router.post('/register', async (req, res) => {
        const { name } = req.body;
        const authToken = req.headers['x-wara-token'] as string;

        if (!name) return res.status(400).json({ error: 'Missing name' });

        // VALIDATION: Prevent registration if the node already has a name (locked)
        if (node.identity.nodeName) {
            return res.status(403).json({ error: `Node is already registered as ${node.identity.nodeName}` });
        }

        try {
            // 1. Authorization: Valid Session Token ONLY
            // The User IS the Owner. Simple.
            const userSigner = node.identity.activeWallets.get(authToken);

            if (!userSigner) {
                return res.status(401).json({ error: 'No active session. Please login.' });
            }

            if (!node.identity.nodeSigner) {
                return res.status(500).json({ error: 'Node Technical Identity not initialized' });
            }

            // 2. Standardize Name (.wara)
            const cleanName = name.replace('.wara', '').replace('.muggi', ''); // Remove any existing suffix
            const finalName = `${cleanName}.wara`;

            console.log(`[Web3] Registering ${finalName} for User: ${userSigner.address}`);

            // 3. Connect Signer
            const connectedSigner = userSigner.connect(node.blockchain.provider);
            const contractWithUser = node.blockchain.nodeRegistry!.connect(connectedSigner) as any;

            // 4. Calculate Fee
            const techAddress = node.identity.nodeSigner.address;
            const baseFee = await contractWithUser.registrationFee();

            // Simplified Fee Logic (Sentinel Budget)
            const feeData = await node.blockchain.provider.getFeeData();
            const gasPrice = feeData.gasPrice || BigInt(1000000000);
            const sentinelBudget = BigInt(50000 * 365) * gasPrice;

            // Fee = SentinelBudget / 0.6 (Contract keeps 40%, Node gets 60%)
            let finalFee = (sentinelBudget * BigInt(10)) / BigInt(6);
            if (finalFee < baseFee) finalFee = baseFee;

            console.log(`[Web3] Sending TX. Payer: ${connectedSigner.address}, Tech Node: ${techAddress}, Fee: ${ethers.formatEther(finalFee)} ETH`);

            // 5. Execute Registration
            const tx = await contractWithUser.registerNode(finalName, techAddress, { value: finalFee });
            console.log(`[Web3] TX sent: ${tx.hash}`);

            // Wait for confirmation and check status
            const receipt = await tx.wait();

            if (!receipt || receipt.status !== 1) {
                throw new Error(`Transaction failed on-chain. Status: ${receipt?.status}. Check gas or contract rules.`);
            }

            console.log(`[Web3] TX confirmed in block ${receipt.blockNumber}`);

            // 6. Update Local Identity
            const idPath = path.join(CONFIG.DATA_DIR, 'node_identity.json');
            // Read or create default structure
            let identity: any = {};
            if (fs.existsSync(idPath)) {
                identity = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
            } else {
                identity = { nodeKey: node.identity.nodeSigner.privateKey };
            }

            identity.name = finalName;
            identity.owner = userSigner.address;
            identity.registeredAt = Date.now();
            identity.txHash = tx.hash;

            fs.writeFileSync(idPath, JSON.stringify(identity, null, 2));

            // 7. Activate Identity in memory
            node.identity.nodeName = identity.name;
            node.identity.nodeOwner = identity.owner;
            node.identity.startSentinelCron();

            res.json({
                success: true,
                name: node.identity.nodeName,
                address: techAddress,
                owner: userSigner.address,
                txHash: tx.hash
            });

            console.log(`[Web3] Identity ACTIVATED: ${node.identity.nodeName}`);

        } catch (e: any) {
            console.error("[Web3] Registration failed:", e);
            res.status(500).json({ error: e.message || 'Registration failed' });
        }
    });

    // Get registration fee
    router.get('/registration-fee', async (req: Request, res: Response) => {
        try {
            const baseFee = await node.blockchain.nodeRegistry!.registrationFee();
            const feeData = await node.blockchain.provider.getFeeData();

            // Prefer maxFeePerGas (EIP-1559) or gasPrice, fallback to 2 Gwei
            const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || BigInt(2000000000);

            // 2 updates per day for 365 days
            const dailyGasBudget = BigInt(50000 * 2);
            const yearlyGasBudget = dailyGasBudget * BigInt(365);
            const sentinelBudget = yearlyGasBudget * gasPrice;

            // Fee calculation: Total = SentinelBudget / 0.9 (Split 10/90)
            let calculatedFee = (sentinelBudget * BigInt(10)) / BigInt(9);

            if (calculatedFee < baseFee) calculatedFee = baseFee;

            res.json({
                fee: calculatedFee.toString(),
                displayFee: ethers.formatEther(calculatedFee),
                baseFee: baseFee.toString(),
                gasPriceEstimate: ethers.formatUnits(gasPrice, 'gwei')
            });
        } catch (e) {
            console.error("[Web3 Error]", e);
            res.status(500).json({ error: 'Failed to fetch fee' });
        }
    });
    // Check if a .wara name exists
    router.get('/name-exists/:name', async (req: Request, res: Response) => {
        try {
            const name = req.params.name.replace('.wara', '');
            const exists = await node.blockchain.nodeRegistry!.nameExists(name);
            res.json({ exists });
        } catch (e) {
            console.error("[Web3 Error]", e);
            res.status(500).json({ error: 'Failed to check registry' });
        }
    });

    // Get info for any registered node
    router.get('/node-info/:name', async (req: Request, res: Response) => {
        try {
            const name = req.params.name.replace('.wara', '');
            const info = await node.blockchain.nodeRegistry!.getNode(name);
            // info: [operator, nodeAddress, expiresAt, active]
            res.json({
                operator: info[0] || info.operator,
                nodeAddress: info[1] || info.nodeAddress,
                expiresAt: Number(info[2] || info.expiresAt),
                active: info[3] || info.active
            });
        } catch (e) {
            console.error("[Web3 Error]", e);
            res.status(500).json({ error: 'Node not found or registry error' });
        }
    });

    return router;
};