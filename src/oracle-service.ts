import { ethers } from 'ethers';
import { WaraNode } from './node';
import { WARA_ORACLE_ADDRESS, WARA_ORACLE_ABI, NODE_REGISTRY_ADDRESS, NODE_REGISTRY_ABI, WARA_TOKEN_ADDRESS } from './contracts';
import axios from 'axios';

const UNISWAP_ROUTER_ADDRESS = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008"; // Sepolia
const WETH_ADDRESS = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const CHAINLINK_ETH_USD = "0x694AA1769357215DE4FAC081bf1f309aDC325306"; // Sepolia

const UNISWAP_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const CHAINLINK_FEED_ABI = [
    "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
];

interface JudgeAssignment {
    cycleId: number;
    rank: number;
    judges: any[];
    startTime: number;
}

export class PriceOracleService {
    private node: WaraNode;
    private interval: NodeJS.Timeout | null = null;
    private currentAssignment: JudgeAssignment | null = null;

    constructor(node: WaraNode) {
        this.node = node;
    }

    public async start() {
        console.log("[Oracle] Starting Smart Committee Service...");
        // Check every 30s if we need to act
        this.interval = setInterval(() => this.checkAssignment(), 30000);
        this.checkAssignment();
    }

    public async stop() {
        if (this.interval) clearInterval(this.interval);
    }

    /**
     * Called by /oracle/notify endpoint when this node is assigned as Judge
     */
    public async setJudgeAssignment(cycleId: number, rank: number, judges: any[], startTime: number) {
        this.currentAssignment = { cycleId, rank, judges, startTime };
        console.log(`[Oracle] Assignment saved: Juez #${rank} para ciclo ${cycleId}`);

        // Immediately check if it's time to act
        await this.checkAssignment();
    }

    /**
     * Checks if we have an assignment and if it's time to act
     */
    private async checkAssignment() {
        if (!this.currentAssignment) return;
        if (!this.node.nodeSigner) return;

        const { cycleId, rank, judges, startTime } = this.currentAssignment;
        const now = Date.now();
        const mySlot = startTime + (rank * 60 * 1000); // My 1-minute window

        // Not my turn yet
        if (now < mySlot) {
            const waitTime = Math.floor((mySlot - now) / 1000);
            if (waitTime < 60) { // Only log if less than 1 minute away
                console.log(`[Oracle] Esperando ${waitTime}s hasta mi turno...`);
            }
            return;
        }

        // My window has passed (more than 1 minute ago)
        if (now > mySlot + 60 * 1000) {
            console.log(`[Oracle] Mi ventana expiró. Limpiando asignación.`);
            this.currentAssignment = null;
            return;
        }

        // It's my turn! Act as Judge
        console.log(`[Oracle] ¡Es mi turno! Actuando como Juez #${rank}...`);
        await this.actAsJudge(cycleId, rank, judges, startTime);

        // Clear assignment after acting
        this.currentAssignment = null;
    }

    /**
     * Act as Judge: collect signatures and submit price
     */
    private async actAsJudge(cycleId: number, myRank: number, judges: any[], startTime: number) {
        try {
            // 1. Get market price
            const price = await this.getMarketPrice();
            if (price === 0) {
                console.warn('[Oracle] No se pudo obtener precio de mercado. Abortando.');
                return;
            }

            const timestamp = Math.floor(Date.now() / 1000);

            console.log(`[Oracle] Consultando lista de Jurado desde blockchain...`);

            // 2. Get jury list from contract
            const oracle = new ethers.Contract(WARA_ORACLE_ADDRESS, WARA_ORACLE_ABI, this.node.provider);
            const [juryAddresses, juryIPs, juryNames] = await oracle.getElectedJury();

            console.log(`[Oracle] Jurado seleccionado por lotería: ${juryAddresses.length} nodos`);

            // 3. Collect signatures from jury
            const signatures: { signature: string, nodeAddress: string }[] = [];

            for (let i = 0; i < juryAddresses.length; i++) {
                const jurorAddress = juryAddresses[i];
                const jurorIP = juryIPs[i];
                const jurorName = juryNames[i];

                // Skip if it's me (I'll sign at the end)
                if (jurorAddress.toLowerCase() === this.node.nodeSigner!.address.toLowerCase()) {
                    continue;
                }

                try {
                    const endpoint = jurorIP.startsWith('http') ? jurorIP : `http://${jurorIP}`;

                    const res = await axios.post(`${endpoint}/oracle/sign-price`, {
                        cycleId,
                        price,
                        timestamp
                    }, {
                        timeout: 2000,
                        headers: { 'Content-Type': 'application/json' }
                    });

                    if (res.status === 200 && res.data.signature) {
                        signatures.push({
                            signature: res.data.signature,
                            nodeAddress: res.data.nodeAddress
                        });
                        console.log(`[Oracle] ✓ Firma recibida de ${jurorName}`);
                    } else {
                        console.warn(`[Oracle] ✗ ${jurorName} rechazó firmar (status: ${res.status})`);
                    }
                } catch (e: any) {
                    console.warn(`[Oracle] ✗ ${jurorName} no respondió:`, e.message);
                }
            }

            // 4. Add my own signature
            const mySignature = await this.signObservation(
                BigInt(Math.round(price * 1e8)),
                timestamp
            );
            signatures.push({
                signature: mySignature,
                nodeAddress: this.node.nodeSigner!.address
            });

            console.log(`[Oracle] Firmas recolectadas: ${signatures.length}/${juryAddresses.length}`);

            // 5. Check if we have enough signatures
            const registry = new ethers.Contract(NODE_REGISTRY_ADDRESS, NODE_REGISTRY_ABI, this.node.provider);
            const totalNodes = await registry.getActiveNodeCount();
            const required = Math.max(3, Math.floor(Number(totalNodes) * 0.2));

            if (signatures.length >= required) {
                console.log(`[Oracle] ✓ Suficientes firmas (${signatures.length}/${required}). Enviando a blockchain...`);
                await this.submitPrice(price, timestamp, signatures.map(s => s.signature));
            } else {
                console.warn(`[Oracle] ✗ Firmas insuficientes (${signatures.length}/${required}). Abortando.`);
            }

        } catch (e: any) {
            console.error('[Oracle] Error actuando como Juez:', e.message);
        }
    }

    /**
     * Sign a price observation
     */
    public async signObservation(price: bigint, timestamp: number): Promise<string> {
        if (!this.node.nodeSigner) throw new Error('Node signer not initialized');

        const messageHash = ethers.solidityPackedKeccak256(
            ["int256", "uint256", "uint256"],
            [price, timestamp, (await this.node.provider.getNetwork()).chainId]
        );

        return await this.node.nodeSigner.signMessage(ethers.getBytes(messageHash));
    }

    /**
     * Submit price to blockchain
     */
    private async submitPrice(price: number, timestamp: number, signatures: string[]) {
        if (!this.node.nodeSigner) return;

        const oracle = new ethers.Contract(WARA_ORACLE_ADDRESS, WARA_ORACLE_ABI, this.node.provider);
        const priceInOracleFormat = BigInt(Math.round(price * 1e8));

        const contractWithSigner = oracle.connect(this.node.nodeSigner);

        try {
            const tx = await (contractWithSigner as any).submitPrice(priceInOracleFormat, timestamp, signatures);
            console.log(`[Oracle] Transaction Sent: ${tx.hash}`);
            await tx.wait();
            console.log("[Oracle] ✅ Consensus Finalized on Blockchain!");
        } catch (e: any) {
            console.warn("[Oracle] Submission failed:", e.message);
        }
    }

    /**
     * Calculates the WARA/USD price by combining Uniswap (WARA/ETH) and Chainlink (ETH/USD)
     */
    public async getMarketPrice(): Promise<number> {
        try {
            const router = new ethers.Contract(UNISWAP_ROUTER_ADDRESS, UNISWAP_ABI, this.node.provider);
            const ethFeed = new ethers.Contract(CHAINLINK_ETH_USD, CHAINLINK_FEED_ABI, this.node.provider);

            // 1. Get ETH/USD from Chainlink
            const [, ethPriceAnswer] = await ethFeed.latestRoundData();
            const ethPrice = Number(ethPriceAnswer) / 1e8;

            // 2. Get WARA/ETH from Uniswap
            const amountIn = ethers.parseUnits("1", 18); // 1 WARA
            const path = [WARA_TOKEN_ADDRESS, WETH_ADDRESS];
            const amounts = await router.getAmountsOut(amountIn, path);
            const waraEthPrice = Number(ethers.formatUnits(amounts[1], 18));

            const waraUsdPrice = waraEthPrice * ethPrice;
            // console.log(`[Oracle] Market Discovery: ETH=$${ethPrice.toFixed(2)} | WARA=${waraEthPrice.toFixed(6)} ETH | WARA=$${waraUsdPrice.toFixed(4)} USD`);

            return waraUsdPrice;
        } catch (e: any) {
            console.error("[Oracle] Market Discovery failed:", e.message);
            return 0;
        }
    }
}
