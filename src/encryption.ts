import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';

// Derive a 32-byte key from the password/salt
function deriveKey(password: string, salt: Buffer) {
    return crypto.scryptSync(password, salt, 32);
}

export function encryptPrivateKey(privateKey: string, password: string): string {
    const salt = crypto.randomBytes(16);
    const key = deriveKey(password, salt);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Format: salt:iv:encrypted
    return `${salt.toString('hex')}:${iv.toString('hex')}:${encrypted}`;
}

export function decryptPrivateKey(encryptedString: string, password: string): string {
    const [saltHex, ivHex, encrypted] = encryptedString.split(':');

    if (!saltHex || !ivHex || !encrypted) {
        throw new Error('Invalid encrypted format');
    }

    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const key = deriveKey(password, salt);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

export function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
    const [salt, hash] = storedHash.split(':');
    const verifyHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return hash === verifyHash;
}

export function encryptPayload(data: any, secretKey: string): string {
    const jsonStr = JSON.stringify(data);
    // Use secretKey as password, random salt
    return encryptPrivateKey(jsonStr, secretKey);
}

export function decryptPayload(encryptedString: string, secretKey: string): any {
    const jsonStr = decryptPrivateKey(encryptedString, secretKey);
    return JSON.parse(jsonStr);
}
