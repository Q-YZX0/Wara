import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createEncryptedStream } from './crypto';
import { WaraMap } from '../types';
import { ethers } from 'ethers';

// Utility to create a Wara Link from a file
export async function createWaraLink(
    filePath: string,
    title: string,
    outputDir: string,
    mediaInfo?: WaraMap['mediaInfo'],
    hosterAddress?: string
): Promise<{ map: WaraMap, key: string, encryptedPath: string }> {

    // Generate ID
    const id = crypto.randomBytes(8).toString('hex');
    const key = crypto.randomBytes(32); // 256-bit key
    const encryptedPath = path.join(outputDir, `${id}.wara`);

    // Create encrypted file
    const { iv, authTag, size, hash } = await createEncryptedStream(filePath, encryptedPath, key);

    // Compute waraId if mediaInfo is present
    let waraId: string | undefined = undefined;
    if (mediaInfo?.source && mediaInfo?.sourceId) {
        try {
            waraId = ethers.solidityPackedKeccak256(["string", "string"], [String(mediaInfo.source), `:${String(mediaInfo.sourceId)}`]);
        } catch (e) { }
    }

    const map: WaraMap = {
        id,
        title,
        mimeType: 'video/mp4', // auto-detect in future
        size,
        status: 'online',
        waraId,
        encryptionAlgo: 'AES-256-CTR',
        compressionAlgo: 'none',
        iv,
        authTag,
        hash,
        publicEndpoint: '', // Assigned by Node
        mediaInfo,
        hosterAddress
    };

    // SAVE METADATA TO DISK (Include key locally so it survives node restart)
    const mapWithKey = { ...map, key: key.toString('hex') };
    fs.writeFileSync(path.join(outputDir, `${id}.json`), JSON.stringify(mapWithKey, null, 2));

    return {
        map,
        key: key.toString('hex'), // User needs this!
        encryptedPath
    };
}
