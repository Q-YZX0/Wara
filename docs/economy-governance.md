# Wara Economy & Governance

This document describes the financial and democratic mechanisms that power the Wara network, ensuring hosters are rewarded and content is verified without requiring users to pay gas for every action.

## 1. Gasless Infrastructure (The Signature Model)

Wara uses off-chain signatures to remove the "Gas Friction" for users.

### Gasless Voting
- **Mechanism**: When a user votes on a content link or a DAO proposal, they don't send a transaction. Instead, they sign a message containing their vote preference.
- **Relaying**: The WaraNode collects these signatures. A "Relayer" (usually the uploader or the node itself) batches these signatures and submits them to the blockchain in a single transaction, paying the gas cost.
- **Benefits**: Users can participate in governance for free.

### Gasless Ad Rewards
- **Mechanism**: When a viewer watches an advertisement, they sign a digital "Proof of View".
- **Claiming**: The hoster (the node serving the video) collects this signature. The hoster later submits this proof to the `AdManager` contract to claim tokens from the advertiser's budget.

---

## 2. Hoster Rewards Economy

Hosters (nodes that serve video content) have two main revenue streams:

### A. Ad-Supported (Free Tier)
1. **Advertisers**: Deposit $WARA into the `AdManager` contract to create a campaign.
2. **Delivery**: When a user watches the ad, the hoster earns a fee in $WARA per view.
3. **Requirement**: Guaranteed by the signed proofs from the viewers.

### B. Premium (Subscription Tier)
1. **Users**: Pay a monthly subscription in $WARA (e.g., $5 USD equivalent).
2. **Revenue Split**: 70% goes into a **Hoster Reward Pool**, 20% to the Treasury, and 10% to the Protocol Creator.
3. **Earning**: Hosters serving premium content to active subscribers claim rewards from the Hoster Reward Pool. The more quality content they serve, the more they earn.

---

## 3. Content DAO & Official Catalog

Wara is decentralized; there is no central "Owner" of the catalog. Instead, it is managed by a DAO.

### Official Catalog Approval
- **Proposals**: Any user can "Propose" a new movie or series to be added to the official catalog via the `MediaRegistry`.
- **Voting**: Token holders and nodes vote on the proposal.
- **Resolution**: If the proposal reaches the required consensus, it is marked as **Official**. Official titles appear with a verified badge and are prioritized in search results.

### Suggestions & Community Links
- Anyone can suggest links for existing content.
- The community uses the **Trust Score** system (upvotes/downvotes) to filter out fake or low-quality links.
- High Trust Score links earn more reputation and are more likely to be served.
