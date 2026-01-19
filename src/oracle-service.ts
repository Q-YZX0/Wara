import { ethers } from 'ethers';
import { WaraNode } from './node';
import { WARA_ORACLE_ADDRESS, WARA_ORACLE_ABI, NODE_REGISTRY_ADDRESS, NODE_REGISTRY_ABI } from './contracts';

const UNISWAP_ROUTER_ADDRESS = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008"; // Sepolia
const WETH_ADDRESS = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const WARA_TOKEN_ADDRESS = "0x77815D33563D53e33eF7939765c85b8F4169A660";
const CHAINLINK_ETH_USD = "0x694AA1769357215DE4FAC081bf1f309aDC325306"; // Sepolia

const UNISWAP_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const CHAINLINK_FEED_ABI = [
    "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
];

export class PriceOracleService {
    private node: WaraNode;
    private interval: NodeJS.Timeout | null = null;
    private collectedSignatures: Map<string, { price: bigint, timestamp: number, signature: string }> = new Map();

    constructor(node: WaraNode) {
        this.node = node;
    }

    public async start() {
        console.log("[Oracle] Starting Jury/Judge Discovery Service...");
        this.interval = setInterval(() => this.sync(), 60000); // Every minute
        this.sync();
    }

    public async stop() {
        if (this.interval) clearInterval(this.interval);
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
            console.log(`[Oracle] Market Discovery: ETH=$${ethPrice.toFixed(2)} | WARA=${waraEthPrice.toFixed(6)} ETH | WARA=$${waraUsdPrice.toFixed(4)} USD`);

            return waraUsdPrice;
        } catch (e: any) {
            console.error("[Oracle] Market Discovery failed:", e.message);
            return 0;
        }
    }

    private async sync() {
        const currentPrice = await this.getMarketPrice();
        if (currentPrice === 0) return;

        const priceInOracleFormat = BigInt(Math.round(currentPrice * 1e8));
        const timestamp = Math.floor(Date.now() / 1000);

        try {
            // 1. Sign our own observation as a potential Jury member
            const signature = await this.signObservation(priceInOracleFormat, timestamp);
            if (signature) {
                // In a full P2P implementation, we would broadcast this signature.
                // For now, we store it locally and behave as a Judge if we collect enough.
                this.collectedSignatures.set(this.node.nodeSigner!.address, {
                    price: priceInOracleFormat,
                    timestamp: timestamp,
                    signature: signature
                });
            }

            // 2. Act as Judge: Try to submit if we have enough signatures
            await this.trySubmitAsJudge();

        } catch (e: any) {
            console.error("[Oracle] Sync cycle failed:", e.message);
        }
    }

    private async signObservation(price: bigint, timestamp: number): Promise<string | null> {
        if (!this.node.nodeSigner) return null;

        const messageHash = ethers.solidityPackedKeccak256(
            ["int256", "uint256", "uint256"],
            [price, timestamp, (await this.node.provider.getNetwork()).chainId]
        );

        return await this.node.nodeSigner.signMessage(ethers.getBytes(messageHash));
    }

    private async trySubmitAsJudge() {
        if (!this.node.nodeSigner) return;

        const oracle = new ethers.Contract(WARA_ORACLE_ADDRESS, WARA_ORACLE_ABI, this.node.provider);
        const registry = new ethers.Contract(NODE_REGISTRY_ADDRESS, NODE_REGISTRY_ABI, this.node.provider);

        const totalNodes = await registry.getActiveNodeCount();
        const required = Math.max(3, Math.floor(Number(totalNodes) * 0.2)); // 20% jury

        // Filter valid signatures (ignore old ones)
        const now = Math.floor(Date.now() / 1000);
        const validSigs = Array.from(this.collectedSignatures.values()).filter(s => (now - s.timestamp) < 300);

        if (validSigs.length >= required) {
            console.log(`[Oracle] Acting as Judge. Collected ${validSigs.length}/${required} signatures. Submitting...`);

            const firstObs = validSigs[0];
            const signatures = validSigs.map(s => s.signature);

            const contractWithSigner = oracle.connect(this.node.nodeSigner);
            try {
                const tx = await (contractWithSigner as any).submitPrice(firstObs.price, firstObs.timestamp, signatures);
                console.log(`[Oracle] Price submission sent: ${tx.hash}`);
                await tx.wait();
                console.log("[Oracle] Price submission confirmed!");
                this.collectedSignatures.clear(); // Reset after successful submission
            } catch (e: any) {
                console.warn("[Oracle] Judge submission rejected (possibly already updated or not jury selection):", e.message);
            }
        }
    }
}
