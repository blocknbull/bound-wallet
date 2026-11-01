#!/usr/bin/env node
// A paid API: every route answers 402 until the caller pays the quoted price
// through their Bound wallet and retries with the X-PAYMENT proof.
//
//   PAYTO=you.testnet node examples/x402-server.mjs
//   PORT=4402  NEAR_NETWORK=testnet  PRICE_CHEAP=0.05  PRICE_PRICEY=0.4
import { createServer } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(new URL("../sdk/package.json", import.meta.url));
const { paymentRequired, verifyPayment, networkName, HEADER } = require("./dist/x402.js");
const { rpcUrl, NEAR } = require("./dist/index.js");

const PAYTO = process.env.PAYTO;
if (!PAYTO) { console.error("set PAYTO=<near account that receives payments>"); process.exit(1); }
const PORT = Number(process.env.PORT ?? 4402);
const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
const PRICES = {
  "/cheap": NEAR(process.env.PRICE_CHEAP ?? "0.05"),
  "/pricey": NEAR(process.env.PRICE_PRICEY ?? "0.4"),
};
const seen = new Set();

createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const price = PRICES[path];
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (!price) return send(404, { error: "try /cheap or /pricey" });

  const requirements = {
    scheme: "near-native",
    network: networkName(NETWORK),
    payTo: PAYTO,
    amountYocto: price,
    description: `one call to ${path}`,
    resource: path,
  };
  const proof = req.headers[HEADER] ?? null;
  const v = await verifyPayment(proof, requirements, { rpcUrl: rpcUrl(NETWORK), seen });
  if (!v.ok) {
    const { status, body } = paymentRequired(requirements);
    console.log(`402 ${path} (${v.reason})`);
    return send(status, { ...body, error: v.reason });
  }
  console.log(`200 ${path} paid by ${v.wallet}`);
  send(200, { data: `premium answer from ${path}`, paidBy: v.wallet, at: new Date().toISOString() });
}).listen(PORT, () => console.log(`x402 vendor on http://localhost:${PORT}  (payTo ${PAYTO}, ${NETWORK})`));
