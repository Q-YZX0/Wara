import { App } from './App';

// Start the node
async function main() {
    try {
        const app = new App();
        await app.start();

        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n[App] Stopping Wara Node...');
            // Stop services if they have stop methods
            app.p2p.stop();
            app.ads.stop();
            await app.oracle.stop();
            await app.prisma.$disconnect();
            process.exit();
        });
    } catch (e) {
        console.error("[App] Fatal error during startup:", e);
        process.exit(1);
    }
}

// Start the node ONLY if run directly
if (require.main === module) {
    main();
}

// Re-export utility for external use
export { createWaraLink } from './utils/LinkCreator';
export type { WaraMap } from './types';
