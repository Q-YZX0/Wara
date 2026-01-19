import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env from the correct place
dotenv.config({ path: path.join(__dirname, '../.env') });

const UNISWAP_ROUTER_ADDRESS = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
const WETH_ADDRESS = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const WARA_TOKEN_ADDRESS = "0x77815D33563D53e33eF7939765c85b8F4169A660";
const CHAINLINK_ETH_USD = "0x694AA1769357215DE4FAC081bf1f309aDC325306";

const UNISWAP_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const CHAINLINK_FEED_ABI = [
    "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
];

async function testPriceDiscovery() {
    const rpcUrl = process.env.RPC_URL || 'https://rpc.ankr.com/eth_sepolia';
    console.log(`Using RPC: ${rpcUrl}`);
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    try {
        const router = new ethers.Contract(UNISWAP_ROUTER_ADDRESS, UNISWAP_ABI, provider);
        const ethFeed = new ethers.Contract(CHAINLINK_ETH_USD, CHAINLINK_FEED_ABI, provider);

        // 1. Get ETH/USD
        console.log("Fetching ETH/USD from Chainlink...");
        const [, ethPriceAnswer] = await ethFeed.latestRoundData();
        const ethPrice = Number(ethPriceAnswer) / 1e8;
        console.log(`ETH Price: $${ethPrice.toFixed(2)}`);

        // 2. Get WARA/ETH
        console.log("Fetching WARA/ETH from Uniswap...");
        const amountIn = ethers.parseUnits("1", 18);
        const path = [WARA_TOKEN_ADDRESS, WETH_ADDRESS];
        const amounts = await router.getAmountsOut(amountIn, path);
        const waraEthPrice = Number(ethers.formatUnits(amounts[1], 18));
        console.log(`WARA/ETH: ${waraEthPrice.toFixed(6)}`);

        const waraUsdPrice = waraEthPrice * ethPrice;
        console.log(`\n=========================================`);
        console.log(`RESULT: 1 WARA = $${waraUsdPrice.toFixed(4)} USD`);
        console.log(`=========================================`);

    } catch (e: any) {
        console.error("Test failed:", e.message);
    }
}

testPriceDiscovery();
