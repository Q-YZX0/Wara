import { ethers } from 'ethers';
import axios from 'axios';
import { CONFIG, ABIS } from '../config/config';
import { IdentityService } from './IdentityService';
import { BlockchainService } from './BlockchainService';

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

export class OracleService {
    private interval: NodeJS.Timeout | null = null;
    private currentAssignment: JudgeAssignment | null = null;

    constructor(
        private identityService: IdentityService,
        private blockchainService: BlockchainService
    ) { }

    public async start() {
        console.log("[Oracle] Starting Smart Committee Service...");
        this.interval = setInterval(() => this.checkAssignment(), 30000);
        this.checkAssignment();
    }

    public async stop() {
        if (this.interval) clearInterval(this.interval);
    }

    public async setJudgeAssignment(cycleId: number, rank: number, judges: any[], startTime: number) {
        this.currentAssignment = { cycleId, rank, judges, startTime };
        console.log(`[Oracle] Assignment saved: Juez #${rank} para ciclo ${cycleId}`);
        await this.checkAssignment();
    }

    private async checkAssignment() {
        if (!this.currentAssignment) return;
        if (!this.identityService.nodeSigner) return;

        const { cycleId, rank, judges, startTime } = this.currentAssignment;
        const now = Date.now();
        const mySlot = startTime + (rank * 60 * 1000);

        // Not my turn yet
        if (now < mySlot) {
            const waitTime = Math.floor((mySlot - now) / 1000);
            if (waitTime < 60) {
                console.log(`[Oracle] Esperando ${waitTime}s hasta mi turno...`);
            }
            return;
        }

        // My window has passed
        if (now > mySlot + 60 * 1000) {
            console.log(`[Oracle] Mi ventana expiró. Limpiando asignación.`);
            this.currentAssignment = null;
            return;
        }

        // Act as Judge
        console.log(`[Oracle] ¡Es mi turno! Actuando como Juez #${rank}...`);
        await this.actAsJudge(cycleId, rank, judges, startTime);
        this.currentAssignment = null;
    }

    private async actAsJudge(cycleId: number, myRank: number, judges: any[], startTime: number) {
        try {
            const price = await this.getMarketPrice();
            if (price === 0) {
                console.warn('[Oracle] No se pudo obtener precio de mercado. Abortando.');
                return;
            }

            const timestamp = Math.floor(Date.now() / 1000);

            // Get elected jury directly from contract using BlockchainService provider
            if (!this.blockchainService.oracle) return;

            // @ts-ignore
            const [juryAddresses, juryIPs, juryNames] = await this.blockchainService.oracle.getElectedJury();

            console.log(`[Oracle] Jurado seleccionado por lotería: ${juryAddresses.length} nodos`);

            const signatures: { signature: string, nodeAddress: string }[] = [];

            for (let i = 0; i < juryAddresses.length; i++) {
                const jurorAddress = juryAddresses[i];
                const jurorIP = juryIPs[i];
                const jurorName = juryNames[i];

                if (this.identityService.nodeSigner && jurorAddress.toLowerCase() === this.identityService.nodeSigner.address.toLowerCase()) {
                    continue;
                }

                try {
                    const endpoint = jurorIP.startsWith('http') ? jurorIP : `http://${jurorIP}`;

                    const res = await axios.post(`${endpoint}/api/oracle/sign-price`, {
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
                    }
                } catch (e: any) {
                    console.warn(`[Oracle] ✗ ${jurorName} no respondió:`, e.message);
                }
            }

            // My Signature
            const mySignature = await this.signObservation(
                BigInt(Math.round(price * 1e8)),
                timestamp
            );
            signatures.push({
                signature: mySignature,
                // @ts-ignore
                nodeAddress: this.identityService.nodeSigner!.address
            });

            console.log(`[Oracle] Firmas recolectadas: ${signatures.length}/${juryAddresses.length}`);

            // Check required count
            if (this.blockchainService.nodeRegistry) {
                // @ts-ignore
                const totalNodes = await this.blockchainService.nodeRegistry.getActiveNodeCount();
                const required = Math.max(3, Math.floor(Number(totalNodes) * 0.2));

                if (signatures.length >= required) {
                    console.log(`[Oracle] ✓ Suficientes firmas (${signatures.length}/${required}). Enviando a blockchain...`);
                    await this.submitPrice(price, timestamp, signatures.map(s => s.signature));
                } else {
                    console.warn(`[Oracle] ✗ Firmas insuficientes (${signatures.length}/${required}). Abortando.`);
                }
            }

        } catch (e: any) {
            console.error('[Oracle] Error actuando como Juez:', e.message);
        }
    }

    public async signObservation(price: bigint, timestamp: number): Promise<string> {
        if (!this.identityService.nodeSigner) throw new Error('Node signer not initialized');

        const messageHash = ethers.solidityPackedKeccak256(
            ["int256", "uint256", "uint256"],
            [price, timestamp, (await this.blockchainService.provider.getNetwork()).chainId]
        );

        return await this.identityService.nodeSigner.signMessage(ethers.getBytes(messageHash));
    }

    private async submitPrice(price: number, timestamp: number, signatures: string[]) {
        if (!this.identityService.nodeSigner || !this.blockchainService.oracle) return;

        const priceInOracleFormat = BigInt(Math.round(price * 1e8));
        const contractWithSigner = this.blockchainService.oracle.connect(this.identityService.nodeSigner);

        try {
            // @ts-ignore
            const tx = await contractWithSigner.submitPrice(priceInOracleFormat, timestamp, signatures);
            console.log(`[Oracle] Transaction Sent: ${tx.hash}`);
            await tx.wait();
            console.log("[Oracle] ✅ Consensus Finalized on Blockchain!");
        } catch (e: any) {
            console.warn("[Oracle] Submission failed:", e.message);
        }
    }

    public async getMarketPrice(): Promise<number> {
        try {
            const router = new ethers.Contract(UNISWAP_ROUTER_ADDRESS, UNISWAP_ABI, this.blockchainService.provider);
            const ethFeed = new ethers.Contract(CHAINLINK_ETH_USD, CHAINLINK_FEED_ABI, this.blockchainService.provider);

            // 1. Get ETH/USD from Chainlink
            // @ts-ignore
            const [, ethPriceAnswer] = await ethFeed.latestRoundData();
            const ethPrice = Number(ethPriceAnswer) / 1e8;

            // 2. Get WARA/ETH from Uniswap
            const amountIn = ethers.parseUnits("1", 18);
            const path = [CONFIG.CONTRACTS.TOKEN, WETH_ADDRESS];

            // @ts-ignore
            const amounts = await router.getAmountsOut(amountIn, path);
            const waraEthPrice = Number(ethers.formatUnits(amounts[1], 18));

            return waraEthPrice * ethPrice;
        } catch (e: any) {
            console.error("[Oracle] Market Discovery failed:", e.message);
            return 0; // Fallback?
        }
    }
}
