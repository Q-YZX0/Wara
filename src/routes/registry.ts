import { Express, Request, Response } from 'express';
import { WaraNode } from '../node';
import { ethers } from 'ethers';
import path from 'path';
import fs from 'fs';

export const setupRegistryRoutes = (app: Express, node: WaraNode) => {
    // --- Blockchain Identity Endpoints (Muggi Registry) ---

    // POST /api/registry/register
    app.post('/api/registry/register', async (req, res) => {
        const { name } = req.body;
        const authToken = req.headers['x-wara-token'] as string;

        if (!name) return res.status(400).json({ error: 'Missing name' });

        try {
            // 1. Authorization: Valid Session Token ONLY
            // The User IS the Owner. Simple.
            const userSigner = node.activeWallets.get(authToken);

            if (!userSigner) {
                return res.status(401).json({ error: 'No active session. Please login.' });
            }

            if (!node.nodeSigner) {
                return res.status(500).json({ error: 'Node Technical Identity not initialized' });
            }

            // 2. Standardize Name (.wara)
            const cleanName = name.replace('.wara', '').replace('.muggi', ''); // Remove any existing suffix
            const finalName = `${cleanName}.wara`;

            console.log(`[Web3] Registering ${finalName} for User: ${userSigner.address}`);

            // 3. Connect Signer
            const connectedSigner = userSigner.connect(node.provider);
            const contractWithUser = node.registryContract.connect(connectedSigner) as any;

            // 4. Calculate Fee
            const techAddress = node.nodeSigner.address;
            const baseFee = await contractWithUser.registrationFee();

            // Simplified Fee Logic (Sentinel Budget)
            const feeData = await node.provider.getFeeData();
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
            const idPath = path.join(node.dataDir, 'node_identity.json');
            // Read or create default structure
            let identity: any = {};
            if (fs.existsSync(idPath)) {
                identity = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
            } else {
                identity = { nodeKey: node.nodeSigner.privateKey };
            }

            identity.name = finalName;
            identity.owner = userSigner.address;
            identity.registeredAt = Date.now();
            identity.txHash = tx.hash;

            fs.writeFileSync(idPath, JSON.stringify(identity, null, 2));

            // 7. Activate Identity in memory
            node.nodeName = identity.name;
            node.nodeOwner = identity.owner;
            node.startSentinelCron();

            res.json({
                success: true,
                name: node.nodeName,
                address: techAddress,
                owner: userSigner.address,
                txHash: tx.hash
            });

            console.log(`[Web3] Identity ACTIVATED: ${node.nodeName}`);

        } catch (e: any) {
            console.error("[Web3] Registration failed:", e);
            res.status(500).json({ error: e.message || 'Registration failed' });
        }
    });

    // Get registration fee
    app.get('/api/registry/registration-fee', async (req: Request, res: Response) => {
        try {
            const baseFee = await node.registryContract.registrationFee();
            const feeData = await node.provider.getFeeData();

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
    app.get('/api/registry/name-exists/:name', async (req: Request, res: Response) => {
        try {
            const name = req.params.name.replace('.wara', '');
            const exists = await node.registryContract.nameExists(name);
            res.json({ exists });
        } catch (e) {
            console.error("[Web3 Error]", e);
            res.status(500).json({ error: 'Failed to check registry' });
        }
    });

    // Get info for any registered node
    app.get('/api/registry/node-info/:name', async (req: Request, res: Response) => {
        try {
            const name = req.params.name.replace('.wara', '');
            const info = await node.registryContract.getNode(name);
            // info: [operator, nodeAddress, expiresAt, active]
            res.json({
                operator: info[0],
                nodeAddress: info[1],
                expiresAt: Number(info[2]),
                active: info[3]
            });
        } catch (e) {
            console.error("[Web3 Error]", e);
            res.status(500).json({ error: 'Node not found or registry error' });
        }
    });
};