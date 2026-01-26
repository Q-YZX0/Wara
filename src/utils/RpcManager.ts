import { ethers } from 'ethers';

export class RPCManager {
    private primaryRPC: string;
    private communityRPCs: string[] = [
        'https://rpc.ankr.com/eth_sepolia',
        'https://eth-sepolia.public.blastapi.io',
        'https://sepolia.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161', // Public-ish / Shared
        'https://rpc2.sepolia.org'
    ];
    private currentIndex: number = -1;
    private requestCount: number = 0;
    private MAX_REQUESTS_PER_NODE = 1000;

    constructor(primaryRPC: string) {
        this.primaryRPC = primaryRPC;
    }

    public getProvider(): ethers.JsonRpcProvider {
        // Simple strategy: Try primary first. Failover to community.
        // We could also do round-robin to balance load.
        return new ethers.JsonRpcProvider(this.primaryRPC);
    }

    public async callWithFailover<T>(fn: (provider: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
        // Try Primary
        try {
            const provider = new ethers.JsonRpcProvider(this.primaryRPC);
            return await fn(provider);
        } catch (error: any) {
            console.warn(`[RPCManager] Primary RPC failed, attempting failover...`);

            // Try Community RPCs
            for (let i = 0; i < this.communityRPCs.length; i++) {
                this.currentIndex = (this.currentIndex + 1) % this.communityRPCs.length;
                const altRPC = this.communityRPCs[this.currentIndex];

                try {
                    const provider = new ethers.JsonRpcProvider(altRPC);
                    const result = await fn(provider);
                    console.log(`[RPCManager] Failover success with: ${altRPC}`);
                    return result;
                } catch (altError) {
                    console.warn(`[RPCManager] Alt RPC ${altRPC} also failed.`);
                }
            }
            throw error; // Re-throw if all failed
        }
    }

    // Vision: This would be the "Share" endpoint
    public trackRequest() {
        this.requestCount++;
        if (this.requestCount > this.MAX_REQUESTS_PER_NODE) {
            // Signal to stop providing or switch
        }
    }
}
