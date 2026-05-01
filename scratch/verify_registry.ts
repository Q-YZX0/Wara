import { ethers } from 'ethers';
import { CONFIG, ABIS } from '../src/config/config';

async function verify() {
    console.log("--- WARA REGISTRY VERIFIER ---");
    const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
    const nodeRegistry = new ethers.Contract(CONFIG.CONTRACTS.NODE_REGISTRY, ABIS.NODE_REGISTRY, provider);

    const nodeAddress = "0x18C2C16263F5afBc187bfc7BE55815F1623c40B8";
    const testName = "muggi";

    try {
        console.log(`RPC URL: ${CONFIG.RPC_URL}`);
        console.log(`Registry Address: ${CONFIG.CONTRACTS.NODE_REGISTRY}`);
        console.log(`Checking address: ${nodeAddress}`);

        // 1. Reverse lookup
        const nameHash = await nodeRegistry.nodeAddressToNameHash(nodeAddress);
        console.log(`Name Hash for address: ${nameHash}`);

        if (nameHash !== ethers.ZeroHash) {
            const nodeInfo = await nodeRegistry.nodes(nameHash);
            console.log(`Found registered name: ${nodeInfo.name}`);
            console.log(`Status: ${nodeInfo.active ? 'ACTIVE' : 'INACTIVE'}`);
        } else {
            console.log("Result: Address NOT registered for any name.");
        }

        // 2. Direct lookup by name
        console.log(`\nChecking name: ${testName}...`);
        const exists = await nodeRegistry.nameExists(testName);
        console.log(`Exists: ${exists}`);

        if (exists) {
            const info = await nodeRegistry.getNode(testName);
            console.log(`Operator: ${info.operator}`);
            console.log(`Node Address: ${info.nodeAddress}`);
            console.log(`IP: ${info.currentIP}`);
        }

        // 3. Stats
        const count = await nodeRegistry.getActiveNodeCount();
        console.log(`\nTotal Active Nodes in Registry: ${count}`);

    } catch (e) {
        console.error("Error during verification:", e);
    }
}

verify();
