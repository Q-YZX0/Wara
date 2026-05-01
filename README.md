# WaraNode: High-Performance P2P Streaming & Governance Node

**WaraNode** is the backbone of the Muggi ecosystem. It handles decentralized media distribution, community governance (DAO), and ad replication via a robust, peer-to-peer architecture.

> **"Unstoppable Streaming, Community-Owned Content."**

---

## 🌟 Key Features

### 📡 P2P Content Distribution
- **Manifest Serving**: Globally unique `waraId` manifests allow nodes to discover and verify content across the network.
- **Atomic Storage**: Two-step verification process ("Temp" to "Permanent") ensures content integrity before activation.
- **P2P Router**: Direct peer-to-peer streaming with built-in metadata sharding (posters, backdrops).

### 🏛️ DAO Governance & Trust
- **On-Chain Proposing**: Users can propose new media to the global registry using the built-in DAO interface.
- **Community Voting**: Transparent, signature-based voting system to approve or reject content.
- **Consensus Registration**: Once approved by the community, media is automatically synchronized across all nodes.

### 🛡️ Sentinel & Security
- **Sentinel Service**: Automatically monitors and updates the node's public IP in the global registry, ensuring constant availability.
- **Security Modes**:
  - **Local Only**: For maximum privacy, disables remote administration.
  - **Remote Enabled**: Allows management from the Muggi Dashboard using a secure `Admin Key`.

### 📺 Ad Replication Engine
- **Decentralized Sharding**: Nodes cooperatively replicate ad metadata and media based on region and network affinity.
- **Garbage Collection**: Automated cleanup of expired ads to optimize disk space.

---

## 📚 Technical Documentation

Deep dive into the architecture, economy, and internal logic of Wara:

-   **[Ecosystem Roles & Identity](docs/architecture-roles.md)**: Node vs. User wallets, Admin keys, and Hoster responsibilities.
-   **[Architecture: Rewards & Signers](../ARCHITECTURE_REWARDS.md)**: Detailed breakdown of who signs what and who gets paid.
-   **[Roadmap: Road to Production](../ROAD_TO_PRODUCTION.md)**: Strategy for moving from development to a secure Mainnet launch.
-   **[Registration & Sentinel System](docs/registration-sentinel.md)**: Blockchain registration, 10/90 fee split, and gas refills.
-   **[Economy & Governance](docs/economy-governance.md)**: Gasless operations, Reward systems, and DAO content approval.

---

---

## 🚀 Quick Start

### Windows
1. Open PowerShell in the `Wara` folder.
2. Run the setup script:
   ```powershell
   ./setup.ps1
   ```
3. Start the node:
   ```powershell
   npm start
   ```

### Linux/macOS
1. Open terminal in the `Wara` folder.
2. Run the setup script:
   ```bash
   chmod +x setup.sh
   ./setup.sh
   ```
3. Start the node:
   ```bash
   npm start
   ```

---

## 🛠️ Configuration (.env)

| Variable | Description | Default |
| :--- | :--- | :--- |
| `DATABASE_URL` | SQLite connection string | `file:./dev.db` |
| `RPC_URL` | Ethereum Sepolia RPC URL | *(Sepolia Public)* |
| `PORT` | Local service port | `21746` |
| `LOCAL_ONLY` | Privacy mode (true/false) | `true` |
| `TMDB_API_KEY` | Metadata enrichment key | *(None)* |
| `ADMIN_KEY` | Security key for remote dashboard | *(Auto-generated)* |

---

## 📂 Directory Structure

All node data is stored in the `Wara/data/` directory (configurable via `DATA_DIR`):
- `/permanent`: Activated, verified media content.
- `/temp`: Incoming uploads awaiting verification/sealing.
- `/ads`: Locally replicated ad assets.
- `/airdrops`: JSON proof files for claim processing.
- `/posters`: Cached P2P metadata images.
- `peers.json`: Local discovery database.
- `sync_state.json`: Blockchain event tracking.
- `Wara/prisma/dev.db`: SQLite database file.

---

## 🤝 Community & Development

WaraNode is open-source. We welcome contributions to our P2P protocol, governance models, and streaming performance.

- **Frontend**: [Muggi Client](https://github.com/Q-YZX0/Muggi)
- **Web3 Backend**: [Wara Smart Contracts](https://github.com/Q-YZX0/wara-contracts)

**License**: MIT. Developed by the Muggi Community.
