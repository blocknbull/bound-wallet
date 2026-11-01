# Bound dashboard

The owner's view of a Bound wallet: balance, agents and their budgets, pending
approvals, and the wallet's on-chain decision history. Reads go straight to the
NEAR RPC; no indexer, no backend.

```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # static build in dist/
```

Enter any Bound wallet account for a read-only view. To act as the owner,
connect MyNearWallet or Meteor; on testnet you can instead paste the owner's
private key for a local-only session (stored in this browser, nowhere else).
