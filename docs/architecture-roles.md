# Wara Ecosystem: Roles & Identity

Understanding the distinction between addresses, keys, and operational modes in a WaraNode.

## 1. Key Identities

In Wara, we separate **ownership** from **operation** to maximize security.

| Identity | Description | Location | Purpose |
| :--- | :--- | :--- | :--- |
| **Hoster / Owner** (User Signer) | The user's secure identity wallet. | Encrypted Vault (`data/`). | **The Boss.** Pays gas for link registrations, owns content on-chain, and receives ad rewards directly. |
| **Tech Wallet** (Node Signer) | The node's technical wallet. | `data/` (In-Memory). | **The Worker.** Signs IP updates (Sentinel), oracle price votes, and handles automated system tasks. |
| **Admin Key** | A secret 64-char string. | `admin_key.secret` | Authorizes remote control of the node via the Dashboard. |

---

## 2. Operational Modes

### Local Only Mode
-   **No Admin Key**: The node ignores any remote commands.
-   **Security**: Minimal exposure. The node is only accessible from `localhost`.
-   **Dashboard**: You must use the Dashboard on the same machine as the node.

### Remote Enabled Mode
-   **Admin Key**: The node generates an `admin_key.secret`.
-   **Remote Access**: Allows you to link your VPS/Remote Node to your central Dashboard.
-   **API Security**: Every sensitive request requires the `X-Wara-Key` header matching the admin key.

---

## 3. The Node as a Secure Vault

WaraNode functions as both a **Hot Wallet** and a **Cold-ish Storage**:

1.  **Hot Wallet (Technical)**: The `nodeSigner` is "always on" to perform automated tasks (Sentinel). It only holds small amounts of ETH for gas.
2.  **User Wallet (Custodial/Hybrid)**: 
    -   An internal wallet encrypted with the user's password.
    -   **Privacy**: The node never stores the password. The wallet is only "unlocked" in memory when the user is active.
3.  **Portability**: Users can **Export** their private key from the node at any time to move to another provider or use MetaMask, ensuring they always have full control of their funds.
