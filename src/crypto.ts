import * as crypto from 'crypto';
import * as zlib from 'zlib';
import * as fs from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';

const pipe = promisify(pipeline);

const ALGORITHM = 'aes-256-ctr';

export async function createEncryptedWaraStream(
    inputPath: string,
    outputPath: string,
    key: Buffer
): Promise<{ iv: string, authTag: string, size: number, hash: string }> {

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const input = fs.createReadStream(inputPath);
    const output = fs.createWriteStream(outputPath);
    const hashSum = crypto.createHash('sha256');

    return new Promise((resolve, reject) => {
        // Calculate size from file system
        let size = 0;
        try {
            size = fs.statSync(inputPath).size;
        } catch (e) { }

        let calculatedHash = '';

        // Create a pass-through stream that calculates hash
        const { Transform } = require('stream');
        const hashTransform = new Transform({
            transform(chunk: any, encoding: any, callback: any) {
                hashSum.update(chunk);
                this.push(chunk);
                callback();
            }
        });

        // Pipeline: Input -> Hash Calculator -> Cipher -> Output
        input
            .pipe(hashTransform)
            .pipe(cipher)
            .pipe(output);

        output.on('finish', () => {
            calculatedHash = hashSum.digest('hex');
            resolve({
                iv: iv.toString('hex'),
                authTag: '',
                size: size,
                hash: `0x${calculatedHash}` // Return as hex string with 0x prefix
            });
        });

        output.on('error', (err: any) => reject(err));
        input.on('error', (err) => reject(err));
    });
}

export function getDecryptionStream(key: Buffer, iv: string, authTag: string) {
    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(iv, 'hex')
    );
    // CTR has no auth tag

    // Pass through stream (no gunzip)
    const unproccessed = new (require('stream').PassThrough)();

    return { decipher, unproccessed };
}
