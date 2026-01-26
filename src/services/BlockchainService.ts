import { ethers } from 'ethers';
import { CONFIG, ABIS } from '../config/config';
import { IdentityService } from './IdentityService';
import { RPCManager } from '../utils/RpcManager';

export class BlockchainService {
    public provider: ethers.JsonRpcProvider;
    public wallet: ethers.Wallet | ethers.HDNodeWallet | any;
    public rpcManager: RPCManager;

    public formatEther(wei: bigint): string {
        return ethers.formatEther(wei);
    }

    public get ZeroHash(): string {
        return ethers.ZeroHash;
    }

    // Contracts
    public nodeRegistry?: ethers.Contract;
    public subscriptions?: ethers.Contract;
    public adManager?: ethers.Contract;
    public linkRegistry?: ethers.Contract;
    public mediaRegistry?: ethers.Contract;
    public token?: ethers.Contract;
    public gasPool?: ethers.Contract;
    public leaderBoard?: ethers.Contract;
    public airdrop?: ethers.Contract;
    public dao?: ethers.Contract;
    public vesting?: ethers.Contract;
    public oracle?: ethers.Contract;

    constructor(private identityService: IdentityService) {
        // Initialize Provider with optimized timeout settings
        const fetchReq = new ethers.FetchRequest(CONFIG.RPC_URL);
        fetchReq.timeout = 5000;
        this.provider = new ethers.JsonRpcProvider(fetchReq, undefined, { staticNetwork: true });
        this.rpcManager = new RPCManager(CONFIG.RPC_URL);

        // Initialize Wallet (Signer)
        if (this.identityService.nodeSigner) {
            this.wallet = this.identityService.nodeSigner.connect(this.provider);
        } else {
            console.warn("[Blockchain] No Node Signer available. Read-only mode active.");
            this.wallet = ethers.Wallet.createRandom(this.provider); // Temporary fallback
        }
    }

    public async init() {
        console.log(`[Blockchain] Connecting to Chain ID ${CONFIG.CHAIN_ID}...`);

        try {
            const network = await this.provider.getNetwork();
            console.log(`[Blockchain] Connected to ${network.name} (${network.chainId})`);

            if (Number(network.chainId) !== Number(CONFIG.CHAIN_ID)) {
                console.warn(`[Blockchain] WARNING: Configured ChainID(${CONFIG.CHAIN_ID}) matches Network(${network.chainId}) ? `);
            }

            // Initialize Contracts
            this.token = new ethers.Contract(CONFIG.CONTRACTS.TOKEN, ABIS.ERC20, this.wallet);
            this.nodeRegistry = new ethers.Contract(CONFIG.CONTRACTS.NODE_REGISTRY, ABIS.NODE_REGISTRY, this.wallet);
            this.subscriptions = new ethers.Contract(CONFIG.CONTRACTS.SUBSCRIPTIONS, ABIS.SUBSCRIPTIONS, this.wallet);
            this.adManager = new ethers.Contract(CONFIG.CONTRACTS.AD_MANAGER, ABIS.AD_MANAGER, this.wallet);
            this.linkRegistry = new ethers.Contract(CONFIG.CONTRACTS.LINK_REGISTRY, ABIS.LINK_REGISTRY, this.wallet);
            this.mediaRegistry = new ethers.Contract(CONFIG.CONTRACTS.MEDIA_REGISTRY, ABIS.MEDIA_REGISTRY, this.wallet);

            // Optional Contracts (might be null if address is empty in config, though currently all set)
            if (CONFIG.CONTRACTS.GAS_POOL) this.gasPool = new ethers.Contract(CONFIG.CONTRACTS.GAS_POOL, ["function refillGas(address recipient, uint256 amount) external"], this.wallet);
            if (CONFIG.CONTRACTS.LEADER_BOARD) this.leaderBoard = new ethers.Contract(CONFIG.CONTRACTS.LEADER_BOARD, ABIS.LEADER_BOARD, this.wallet);
            if (CONFIG.CONTRACTS.AIRDROP) this.airdrop = new ethers.Contract(CONFIG.CONTRACTS.AIRDROP, ABIS.AIRDROP, this.wallet);
            if (CONFIG.CONTRACTS.DAO) this.dao = new ethers.Contract(CONFIG.CONTRACTS.DAO, ABIS.DAO, this.wallet);
            if (CONFIG.CONTRACTS.ORACLE) this.oracle = new ethers.Contract(CONFIG.CONTRACTS.ORACLE, ABIS.ORACLE, this.wallet);

            console.log(`[Blockchain] Contracts Initialized.`);

        } catch (e: any) {
            console.error(`[Blockchain] Initialization Failed: ${e.message} `);
            // Do not throw, allow node to run in offline/degraded mode
        }
    }

    /**
     * Helper to verify signatures safely
     */
    public verifySignature(message: string, signature: string): string {
        return ethers.verifyMessage(message, signature);
    }
}
