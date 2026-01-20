import { Router, Request, Response } from 'express';
import { WaraNode } from '../node';
import { ethers } from 'ethers';
import { WARA_ORACLE_ADDRESS, WARA_ORACLE_ABI } from '../contracts';

export const setupOracleRoutes = (node: WaraNode) => {
    const router = Router();

    /**
     * POST /api/oracle/notify
     * Recibe notificación del Centinela cuando este nodo es elegido como Juez
     */
    router.post('/notify', async (req: Request, res: Response) => {
        const { cycleId, yourRank, judges, startTime, signature } = req.body;

        if (!node.nodeSigner) {
            return res.status(500).json({ error: 'Node identity not initialized' });
        }

        try {
            // 1. Verificar firma del Centinela (TODO: implementar verificación)
            // const isValid = verifySentinelSignature(signature, cycleId);
            // if (!isValid) {
            //     return res.status(401).json({ error: 'Invalid signature' });
            // }

            // 2. CRÍTICO: Verificar en blockchain que realmente soy juez
            const oracle = new ethers.Contract(
                WARA_ORACLE_ADDRESS,
                WARA_ORACLE_ABI,
                node.provider
            );

            const elected = await oracle.getElectedJudges();
            const myAddress = node.nodeSigner.address.toLowerCase();
            const amIReallyJudge = elected.some((j: any) =>
                j.nodeAddress && j.nodeAddress.toLowerCase() === myAddress
            );

            if (!amIReallyJudge) {
                console.warn('[Oracle] Centinela mintió, no soy juez. Ignorando.');
                return res.status(403).json({ error: 'Not a real judge' });
            }

            // 3. Guardar asignación para actuar en el momento correcto
            if (node.oracleService) {
                await node.oracleService.setJudgeAssignment(cycleId, yourRank, judges, startTime);
                console.log(`[Oracle] ✓ Asignado como Juez #${yourRank} para ciclo ${cycleId}`);
            }

            res.json({ success: true });

        } catch (e: any) {
            console.error('[Oracle] Error en api/oracle/notify:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * POST /api/oracle/sign-price
     * Firma el precio como miembro del Jurado
     */
    router.post('/sign-price', async (req: Request, res: Response) => {
        const { cycleId, price, timestamp } = req.body;

        if (!node.nodeSigner) {
            return res.status(500).json({ error: 'Node identity not initialized' });
        }

        if (!node.oracleService) {
            return res.status(500).json({ error: 'Oracle service not initialized' });
        }

        try {
            // 1. Verificar que el precio es razonable (anti-manipulación)
            const currentPrice = await node.oracleService.getMarketPrice();
            const deviation = Math.abs(price - currentPrice) / currentPrice;

            if (deviation > 0.1) { // 10% max deviation
                return res.status(400).json({
                    error: 'Price deviation too high',
                    yourPrice: currentPrice,
                    requestedPrice: price
                });
            }

            // 2. Firmar el precio
            const priceInOracleFormat = BigInt(Math.round(price * 1e8));
            const messageHash = ethers.solidityPackedKeccak256(
                ["int256", "uint256", "uint256"],
                [priceInOracleFormat, timestamp, 11155111] // Sepolia chainId
            );

            const signature = await node.nodeSigner.signMessage(
                ethers.getBytes(messageHash)
            );

            console.log(`[Oracle] ✓ Firmado precio $${price.toFixed(4)} para ciclo ${cycleId}`);

            res.json({
                signature,
                nodeAddress: node.nodeSigner.address,
                nodeName: node.nodeName || 'unknown'
            });

        } catch (e: any) {
            console.error('[Oracle] Error en api/oracle/sign-price:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
