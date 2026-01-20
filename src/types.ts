export interface WaraMap {
    // Public Information
    id: string;
    title: string;
    description?: string;
    size: number;
    mimeType: string;
    hosterAddress?: string; // Wallet that owns the content
    waraId?: string; // Global on-chain identifier

    // Status (Dynamic)
    status: 'online' | 'offline' | 'busy';
    bandwidth?: number; // kbps
    stats?: {
        activeStreams: number;
        maxStreams: number;
    }

    // Security & Integrity
    encryptionAlgo: 'AES-256-CTR';
    compressionAlgo: 'gzip' | 'none';
    iv: string; // Hex string initialization vector (publicly needed to decrypt)
    authTag: string; // Hex string auth tag
    hash: string; // SHA-256 of original content

    // Access
    publicEndpoint: string; // e.g., "http://localhost:3000/stream/{id}/stream"

    // Content Metadata (Semantic)
    mediaInfo?: {
        source?: string; // tmdb, imdb, etc.
        sourceId?: string; // 12345
        imdbId?: string; // tt1234567
        tmdbId?: string; // 12345
        type: 'movie' | 'episode' | 'other';
        title: string;
        year?: number;
        season?: number;
        episode?: number;
        quality?: string; // 1080p, 4k, etc.
    }

    // Geo & Tracks
    region?: string;
    subtitles?: {
        id: string;
        lang: string;
        label: string;
    }[];
}

export interface WaraLinkConfig {
    port: number;
    host: string;
}
