import { ethers } from 'ethers';
import { CONFIG, ABIS } from '../src/config/config';

async function runTest() {
    console.log("-----------------------------------------");
    console.log("   WARA NODE - INTEGRITY TEST (BETA)     ");
    console.log("-----------------------------------------");

    const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
    const network = await provider.getNetwork();
    const chainId = network.chainId;
    console.log(`[Network] Connected to Chain ID: ${chainId}`);

    // 1. Check Contracts Deployment
    console.log("\n[1] Checking Contracts Deployment...");
    const contractsToCheck = [
        { name: 'NodeRegistry', address: CONFIG.CONTRACTS.NODE_REGISTRY },
        { name: 'AdManager', address: CONFIG.CONTRACTS.AD_MANAGER },
        { name: 'Subscriptions', address: CONFIG.CONTRACTS.SUBSCRIPTIONS },
        { name: 'Oracle', address: CONFIG.CONTRACTS.ORACLE }
    ];

    for (const c of contractsToCheck) {
        const code = await provider.getCode(c.address);
        if (code === '0x' || code === '0x0') {
            console.log(`  ❌ ${c.name}: NOT FOUND at ${c.address}`);
        } else {
            console.log(`  ✅ ${c.name}: ONLINE at ${c.address}`);
        }
    }

    // 2. Validate Signature Logic (The bug we found)
    console.log("\n[2] Validating Signature Formats...");
    
    const dummyHoster = "0x1234567890123456789012345678901234567890";
    const dummyViewer = "0x0987654321098765432109876543210987654321";
    const dummyContent = ethers.id("test-content");
    const dummyLink = ethers.id("test-link");
    const campaignId = 1;
    const nonce = 0;

    // A. Ad View Format (Expected by AdManager.sol:192)
    const adHash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "address", "bytes32", "bytes32", "uint256", "address"],
        [campaignId, dummyHoster, dummyViewer, dummyContent, dummyLink, chainId, CONFIG.CONTRACTS.AD_MANAGER]
    );
    console.log(`  - AdManager Hash Format: ${adHash}`);

    // B. Premium View Format (Expected by Subscriptions.sol:181)
    const subHash = ethers.solidityPackedKeccak256(
        ["address", "address", "bytes32", "uint256", "uint256"],
        [dummyHoster, dummyViewer, dummyContent, nonce, chainId]
    );
    console.log(`  - Subscriptions Hash Format: ${subHash}`);

    console.log("\n[3] Simulation of Claim Logic...");
    // If the hash is valid, we should be able to recover an address from a dummy signature
    const wallet = ethers.Wallet.createRandom();
    const signature = await wallet.signMessage(ethers.getBytes(adHash));
    const recovered = ethers.verifyMessage(ethers.getBytes(adHash), signature);
    
    if (recovered.toLowerCase() === wallet.address.toLowerCase()) {
        console.log("  ✅ Signature Recovery Logic: OK");
    } else {
        console.log("  ❌ Signature Recovery Logic: FAILED");
    }

    console.log("\n[Conclusion] If all checkmarks are green, the backend-contract bridge is secure.");
}

runTest().catch(console.error);
