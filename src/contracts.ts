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
export const WARA_TOKEN_ADDRESS = "0x77815D33563D53e33eF7939765c85b8F4169A660";
export const AD_MANAGER_ADDRESS = "0x2eB638813c4177dd8fEA256d78aaFFA327CBF45F";
export const SUBSCRIPTION_ADDRESS = "0x9a5B33F2771B3b370311FA2bFD56C78981ad679D";
export const NODE_REGISTRY_ADDRESS = "0x4dEfD40BAF4c290F8bc9F947cBc82865f4cE49e4";
export const GAS_POOL_ADDRESS = "0x2e2f1A0A4B83b9E1B6d0cbbcFC6F436eFdBfc4D9";
export const LEADER_BOARD_ADDRESS = "0xfB20b4D2FE2e6f9F5bf757C81735AB406d947A97";
export const LINK_REGISTRY_ADDRESS = "0xdD491Be807d00406F652228197680C1861ec3Cac";
export const MEDIA_REGISTRY_ADDRESS = "0x3A142e0b15DB9b775ABd93e79aff1D7A758d1343";

// New Airdrop & Governance
export const WARA_AIRDROP_ADDRESS = "0xc6FD86f27Fca876B9A0b8405F487bf0d1844e4e5";
export const WARA_DAO_ADDRESS = "0xA3E2fA06233E5e6E30FFbE6887CEBed74465014b";
export const WARA_VESTING_ADDRESS = "0xa171B6b7136C272C12426ffa3D6b9c91750c8a5d";

export const WARA_AIRDROP_ABI = [
    "function register() external",
    "function claim(uint256 cycleId, uint256 amount, bytes32[] calldata merkleProof) external",
    "function getRegisteredUsers() external view returns (address[] memory)",
    "function totalRegistered() external view returns (uint256)",
    "function currentCycleId() external view returns (uint256)",
    "function lastCycleTime() external view returns (uint256)",
    "function isRegistered(address user) external view returns (bool)",
    "function hasClaimed(uint256 cycleId, address user) external view returns (bool)",
    "function cycles(uint256 id) external view returns (bytes32 merkleRoot, uint256 totalAmount, uint256 startTime, bool active)"
];

export const WARA_DAO_ABI = [
    "function createProposal(string calldata description, address recipient, uint256 amount, uint8 pType) external returns (uint256)",
    "function vote(uint256 pId, int8 side) external",
    "function executeProposal(uint256 pId) external",
    "function nextProposalId() external view returns (uint256)",
    "function proposals(uint256 id) external view returns (uint256 id, string description, address recipient, uint256 amount, uint8 pType, uint256 upvotes, uint256 downvotes, uint256 deadline, bool executed, bool approved)"
];



