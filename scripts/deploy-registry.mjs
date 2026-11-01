#!/usr/bin/env node
// Deploy the Bound reputation registry as a sub-account of OWNER in one
// transaction: create account, fund, add the owner's key, deploy, init.
// Usage: OWNER=you.near [NAME=reputation] [BALANCE=2.2] node scripts/deploy-registry.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// near-api-js is a dependency of the sdk; resolve it from there.
const require = createRequire(join(here, "../sdk/package.json"));
const { connect, keyStores, transactions, utils } = require("near-api-js");

const OWNER = process.env.OWNER;
if (!OWNER) { console.error("set OWNER=you.near"); process.exit(1); }
const NAME = process.env.NAME ?? "reputation";
const BALANCE = process.env.BALANCE ?? "2.2";
const NETWORK = process.env.NEAR_NETWORK ?? "mainnet";
const REGISTRY = `${NAME}.${OWNER}`;
const WASM = join(here, "../contract/target/near/bound_reputation.wasm");

const credDir = join(homedir(), ".near-credentials");
const keyStore = new keyStores.UnencryptedFileSystemKeyStore(credDir);
const near = await connect({
  networkId: NETWORK,
  nodeUrl: process.env.NEAR_RPC_URL ?? (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com"),
  keyStore,
});
const owner = await near.account(OWNER);
const pub = JSON.parse(readFileSync(join(credDir, NETWORK, `${OWNER}.json`), "utf8")).public_key;
const res = await owner.signAndSendTransaction({
  receiverId: REGISTRY,
  actions: [
    transactions.createAccount(),
    transactions.transfer(BigInt(utils.format.parseNearAmount(BALANCE))),
    transactions.addKey(utils.PublicKey.from(pub), transactions.fullAccessKey()),
    transactions.deployContract(readFileSync(WASM)),
    transactions.functionCall("new", Buffer.from(JSON.stringify({ owner: OWNER })), 100000000000000n, 0n),
  ],
});
console.log(`registry ${REGISTRY} deployed and initialised: ${res.transaction.hash}`);
