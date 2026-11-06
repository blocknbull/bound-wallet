#!/usr/bin/env node
// Plain NEAR transfer, for topping up a wallet's operating balance. A wallet
// contract locks most of its balance as storage, so `deploy --balance` is not
// the same as spendable funds; this is how you add more.
// Usage: FROM=you.testnet TO=lead.you.testnet AMOUNT=2 node scripts/fund.mjs
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../sdk/package.json"));
const { connect, keyStores, utils } = require("near-api-js");

const { FROM, TO, AMOUNT } = process.env;
if (!FROM || !TO || !AMOUNT) {
  console.error("set FROM=, TO= and AMOUNT= (in NEAR)");
  process.exit(1);
}
const NETWORK = process.env.NEAR_NETWORK ?? "testnet";

const near = await connect({
  networkId: NETWORK,
  nodeUrl:
    process.env.NEAR_RPC_URL ??
    (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com"),
  keyStore: new keyStores.UnencryptedFileSystemKeyStore(join(homedir(), ".near-credentials")),
});

const res = await (await near.account(FROM)).sendMoney(
  TO,
  BigInt(utils.format.parseNearAmount(AMOUNT)),
);
console.log(`sent ${AMOUNT} NEAR: ${FROM} -> ${TO}  ${res.transaction.hash}`);
