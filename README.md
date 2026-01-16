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

## 🚀 Quick Start (Linux/macOS)

The easiest way to set up a WaraNode is using our interactive deployment script:

```bash
cd wara-node
chmod +x deploy_node.sh
./deploy_node.sh
```

The script will guide you through:
1.  **Security Mode**: Choosing between Local or Remote administration.
2.  **Network Setup**: Port configuration (Default: 21746).
3.  **Blockchain Connection**: Setting up your RPC (Sepolia recommended).
4.  **Metadata Integration**: Adding an optional TMDB API key.

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

All node data is stored in the `wara_store/` directory:
- `/permanent`: Activated, verified media content.
- `/temp`: Incoming uploads awaiting verification/sealing.
- `/ads`: Locally replicated ad assets.
- `/posters`: Cached P2P metadata images.
- `peers.json`: Local discovery database.
- `sync_state.json`: Blockchain event tracking.

---

## 🤝 Community & Development

WaraNode is open-source. We welcome contributions to our P2P protocol, governance models, and streaming performance.

- **Frontend**: [Muggi Client](https://github.com/Q-YZX0/Muggi)
- **Web3 Backend**: [Wara Smart Contracts](https://github.com/Q-YZX0/wara-contracts)

**License**: MIT. Developed by the Muggi Community.
