import fs from 'fs';
import path from 'path';

// Manual .env loader
const loadEnv = () => {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        console.log(`[WaraNode] Reading .env at ${envPath}`);
        const content = fs.readFileSync(envPath, 'utf8');
        content.split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const index = trimmed.indexOf('=');
            if (index > 0) {
                // VERY AGGRESSIVE CLEANING
                const key = trimmed.substring(0, index).trim().replace(/[^a-zA-Z0-9_]/g, '');
                const val = trimmed.substring(index + 1).trim()
                    .replace(/^["']|["']$/g, '')
                    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ""); // Remove control characters

                if (!process.env[key]) {
                    process.env[key] = val;
                    console.log(`[WaraNode] Env Set: [${key}]`);
                } else {
                    console.log(`[WaraNode] Env Preserved (System/CLI): [${key}]`);
                }
            }
        });
    } else {
        console.warn(`[WaraNode] .env NOT FOUND at ${envPath}`);
    }
};
loadEnv();

console.log("[WaraNode] Env Verification:", {
    DATABASE_URL: process.env.DATABASE_URL ? "OK" : "MISSING",
    TMDB: process.env.TMDB_API_KEY ? "OK" : "MISSING",
    AllKeys: Object.keys(process.env).filter(k => k.includes('URL') || k.includes('DB') || k.includes('TMDB'))
});

import { WaraNode } from './node';
import { AdReplicator } from './ad-replicator';

// Start the node
const PORT = parseInt(process.env.PORT || '21746');
const DATA_DIR = process.env.DATA_DIR;

console.log(`[WaraNode] Initializing on Port: ${PORT}`);
if (DATA_DIR) console.log(`[WaraNode] Custom DataDir: ${DATA_DIR}`);

const node = new WaraNode(PORT, DATA_DIR);
node.start();

// Start Ad Replicator
const adReplicator = new AdReplicator(node);
adReplicator.start().catch(console.error);

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Stopping Wara Node...');
    adReplicator.stop();
    node.stop();
    process.exit();
});
