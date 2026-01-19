# Node Registration & Sentinel Drip System

This document explains how Wara nodes are registered on the blockchain and how they maintain their gas levels through the Sentinel system.

## 1. The Registration Flow

Nodes are registered on the Wara ecosystem through the `NodeRegistry` contract.

1.  **Preparation**: The WaraNode generates a unique **Tech Wallet** (also called `nodeSigner`). This is the node's "hot" identity for automated tasks.
2.  **Payment**: The **Operator / Owner** (also called `userSigner` the human's secure wallet, handled within the node) initiates the `registerNode` transaction.
    -   The user pays the **Registration Fee** (calculated for 1 year of maintenance).
    -   The user specifies the **Node Name** and the **Tech Wallet Address** (`nodeSigner`).
3.  **Funding Split (10/90)**: To ensure security and longevity, the contract splits the fee:
    -   **10% Upfront**: Sent directly to the `nodeSigner` wallet to provide an initial gas buffer for the first transactions.
    -   **90% GasPool**: Sent to the `GasPool` contract. This money is locked and reserved specifically for this node's future maintenance.

## 2. The Sentinel Role

The **Sentinel** is a background process running inside every WaraNode. Its main mission is to keep the node's entry in the `NodeRegistry` up to date.

### IP Monitoring
Most home internet connections have dynamic IPs. If your IP changes, your node becomes unreachable. The Sentinel:
-   Checks your public IP every 30 minutes.
-   If it detects a change, it sends an `updateIP` transaction to the blockchain.

### The Drip System (Refills)
To prevent the node from running out of gas (ETH) during its 1-year subscription:
-   Every time the Sentinel calls `updateIP`, the `NodeRegistry` triggers an automatic **Refill** from the `GasPool`.
-   The `GasPool` sends a small "drip" of ETH (e.g., 0.001 ETH) back to the **Tech Wallet**.
-   **Security**: This ensures that gas is only consumed if the node is actually active and "working" for the network.
