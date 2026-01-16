export const NODE_REGISTRY_ABI = [
    "function registerNode(string name, address nodeAddress) external payable",
    "function nameExists(string name) external view returns (bool)",
    "function registrationFee() external view returns (uint256)",
    "function getNode(string name) external view returns (address operator, address nodeAddress, uint256 expiresAt, bool active, string currentIP)",
    "function updateIP(string newIP) external",
    "function getBootstrapNodes(uint256 limit) external view returns (string[] names, string[] ips)",
    "function getActiveNodeCount() external view returns (uint256)",
    "event NodeRegistered(string name, address indexed operator, address indexed nodeAddress, uint256 expiresAt)",
    "event IPUpdated(string indexed name, string newIP)"
];

export const SUBSCRIPTIONS_ABI = [
    "function subscribe() external",
    "function isSubscribed(address user) external view returns (bool)",
    "function getCurrentPrice() external view returns (uint256)",
    "function recordPremiumView(address hoster, address viewer, bytes32 contentHash, uint256 nonce, bytes calldata signature) external",
    "function claimHosterReward() external",
    "function getPendingReward(address hoster) view returns (uint256)",
    "function getStats() external view returns (uint256, uint256, uint256, uint256, uint256)",
    "function getSubscription(address user) external view returns (bool active, uint256 expiresAt, uint256 daysRemaining, uint256 totalPaid, uint256 subscriptionCount)"
];

export const AD_MANAGER_ABI = [
    "function nextCampaignId() external view returns (uint256)",
    "function getCampaign(uint256 id) external view returns (address advertiser, uint256 budgetWARA, uint8 duration, string videoHash, uint256 viewsRemaining, uint8 category, bool active)",
    "function getCurrentCostPerView(uint8 duration) external view returns (uint256)",
    "function createCampaign(uint256 budgetWARA, uint8 duration, string memory videoHash, uint8 category) external returns (uint256)",
    "function cancelCampaign(uint256 campaignId) external",
    "function topUpCampaign(uint256 campaignId, uint256 amount) external",
    "function claimAdView(uint256 campaignId, address viewer, bytes32 contentHash, bytes32 linkId, bytes memory signature) external",
    "function reportAd(uint256 campaignId, uint8 reasonCode) external",
    "function getCampaignsByAdvertiser(address advertiser) external view returns (tuple(uint256 id, tuple(address advertiser, uint256 budgetWARA, uint8 duration, string videoHash, uint256 viewsRemaining, uint8 category, bool active) campaign)[])",
    "function getReportCount(uint256 campaignId) external view returns (uint256)",
    "function togglePause(uint256 campaignId) external",
    "function linkReputation() view returns (address)",
    "function setLinkReputation(address _linkReputation)",
    "function owner() view returns (address)"
];

export const ERC20_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address account) external view returns (uint256)"
];

// Add missing ABIs for new contracts
export const LEADER_BOARD_ABI = [
    "function getHosterStats(address hoster) external view returns (uint256, uint256, uint256, uint256, uint256)",
    "function getLeaderboard(uint256 limit) external view returns (address[])",
    "function getTotalHosters() external view returns (uint256)"
];

export const LINK_REGISTRY_ABI = [
    "function registerLink(bytes32 contentHash, bytes32 mediaHash, string calldata salt, address hoster) external returns (bytes32)",
    "function vote(bytes32 linkId, int8 value) external",
    "function voteWithSignature(bytes32 linkId, bytes32 contentHash, int8 value, address voter, address relayer, uint256 nonce, uint256 timestamp, bytes calldata signature) external",
    "function batchVoteWithSignature(bytes32[] linkIds, bytes32[] contentHashes, int8[] values, address[] voters, address[] relayers, uint256[] nonces, uint256[] timestamps, bytes[] signatures) external",
    "function getTrustScore(bytes32 linkId) external view returns (uint256)",
    "function getLinkStats(bytes32 linkId) external view returns (uint256 upvotes, uint256 downvotes, uint256 trustScore, address hoster)",
    "function getLinksRanked(bytes32 mediaHash) external view returns (bytes32[])",
    "event LinkRegistered(bytes32 indexed id, bytes32 contentHash, bytes32 mediaHash, address hoster, string salt)"
];

export const MEDIA_REGISTRY_ABI = [
    "function registerMedia(string source, string externalId, string title, string metadataHash) external",
    "function proposeMedia(string source, string externalId, string title, string metadataHash) external",
    "function vote(string source, string externalId, int8 side) external",
    "function resolveProposal(string source, string externalId, string title, string metadataHash) external",
    "function proposals(bytes32 mediaId) external view returns (uint256 upvotes, uint256 downvotes, uint256 deadline, address proposer, bool executed)",
    "function hasVoted(bytes32 mediaId, address user) external view returns (bool)",
    "function getMedia(bytes32 mediaId) external view returns (tuple(bytes32 id, string source, string externalId, string title, string metadataHash, bool active, uint256 createdAt))",
    "function updateMetadata(bytes32 id, string newHash) external",
    "function setStatus(bytes32 id, bool active) external",
    "function exists(string source, string externalId) external view returns (bool, bytes32)",
    "function computeMediaId(string source, string externalId) public pure returns (bytes32)",
    "function owner() external view returns (address)",
    "event MediaRegistered(bytes32 indexed id, string source, string externalId, string title)"
];

// Verified Deployment Addresses (Sepolia)
export const WARA_TOKEN_ADDRESS = "0xc50Fc3c8110ed06f22f8567da1fA64bb1B2EB289";
export const AD_MANAGER_ADDRESS = "0xb74C7FCE5E62c9cCb8F873f39D45E31c1fF5C9F7";
export const SUBSCRIPTION_ADDRESS = "0xD21908d71da5422aF922139491F5c5c8120FCB43";
export const NODE_REGISTRY_ADDRESS = "0x4099634B44B00F58e0819B021E717728a6D5e2D4"; // NODE_REGISTRY
export const GAS_POOL_ADDRESS = "0x8831b86EE9C93e825d999eAd8158c1145f195bDC";
export const LEADER_BOARD_ADDRESS = "0xFa6440B7F84Cee757a7b41feF26FCf6D1F3AEb17";
export const LINK_REGISTRY_ADDRESS = "0x2761768C62f885058e191f2441d41fadfBC2a3BF";
export const MEDIA_REGISTRY_ADDRESS = "0xC4F8D1ae9ADE9BC6bB41e9Aea481DCD7EBbe0d18";



