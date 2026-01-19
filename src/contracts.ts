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
    "function recordPremiumViewBatch(address[] calldata hosters, address[] calldata viewers, bytes32[] calldata contentHashes, uint256[] calldata nonces, bytes[] calldata signatures) external",
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
    "function batchClaimAdView(uint256[] calldata campaignIds, address[] calldata viewers, bytes32[] calldata contentHashes, bytes32[] calldata linkIds, bytes[] calldata signatures) external",
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
export const WARA_TOKEN_ADDRESS = "0xEfC1a3dF358c4052B08406A3A530Da74eE96DA60";
export const AD_MANAGER_ADDRESS = "0x3B57c6e719A7b155b49E4842272F2B99E922Be4e";
export const SUBSCRIPTION_ADDRESS = "0x683A4Ed0c28F17D455cE3Ead21C372c1E6ed9524";
export const NODE_REGISTRY_ADDRESS = "0xc411B72e3F9C6821Cf0f3672985DCD15e9B2855c";
export const GAS_POOL_ADDRESS = "0x2cfAE62b67e1c2a5aF9e73Ac22B5cbCA8A30dAaB";
export const LEADER_BOARD_ADDRESS = "0x7A4E47F3192F8fcC1F92b0531fffdCb3ccF918B4";
export const LINK_REGISTRY_ADDRESS = "0x8E5c574e89ac6A8FbD7D3EB5584c628C5E7f4bCC";
export const MEDIA_REGISTRY_ADDRESS = "0x8252510Bd99D3742898a86d85403bF75759a280C";

// New Airdrop & Governance
export const WARA_AIRDROP_ADDRESS = "0x958aedd2fE387a369AD208bF00F7e5AE19F37AEb";
export const WARA_DAO_ADDRESS = "0xFbF631CB68f88cCDb730f02A2Fb4752634F1CB3f";
export const WARA_VESTING_ADDRESS = "0x7B5BeED0a933870E9A5fC6DbD28035944B4bBb1e";
export const WARA_ORACLE_ADDRESS = "0x6313b1118f395B0C476afD7Ee8EfA2B0077B09aF";
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

export const WARA_ORACLE_ABI = [
    "function submitPrice(int256 _price, uint256 _timestamp, bytes[] calldata _signatures) external",
    "function latestAnswer() external view returns (int256)",
    "function latestTimestamp() external view returns (uint256)",
    "function decimals() external view returns (uint8)",
    "function owner() external view returns (address)"
];



