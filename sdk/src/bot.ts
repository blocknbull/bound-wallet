#!/usr/bin/env node
/**
 * Approvals bot: the owner's queue, in Telegram.
 *
 * When an agent's action lands above the policy's approval threshold it waits
 * in the wallet's pending queue. This bot watches that queue and sends each
 * new request to the owner's Telegram chat with Approve / Reject buttons.
 * A tap signs the owner call (keys stay in ~/.near-credentials on the machine
 * running the bot; Telegram only ever carries the decision).
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN   from @BotFather
 *   TELEGRAM_CHAT_ID     the owner's chat id (message the bot, it prints it)
 *   BOUND_OWNER          owner account, e.g. boundwallet.near
 *   BOUND_WALLET         wallet account, e.g. agents.boundwallet.near
 *   NEAR_NETWORK         testnet | mainnet (default testnet)
 *   POLL_SECS            queue poll interval (default 10)
 */
import { BoundOwner, fromYocto, type Action, type PendingAction } from "./index.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const OWNER = process.env.BOUND_OWNER;
const WALLET = process.env.BOUND_WALLET;
const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
const POLL_SECS = Number(process.env.POLL_SECS ?? 10);

if (!TOKEN || !OWNER || !WALLET) {
  console.error("set TELEGRAM_BOT_TOKEN, BOUND_OWNER and BOUND_WALLET (and TELEGRAM_CHAT_ID once you know it)");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

async function tg(method: string, body: object): Promise<any> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  // Throw instead of returning undefined. The callers' catch blocks are what
  // sleep between retries, so swallowing the error here turned a bad token
  // into a tight loop hammering the Telegram API with no delay at all.
  if (!data.ok) {
    const err: any = new Error(`telegram ${method}: ${data.description ?? res.status}`);
    // 401/404 on the bot path means the token is wrong or revoked. Retrying
    // never fixes that, so let the caller stop rather than spin forever.
    err.fatal = res.status === 401 || res.status === 404;
    throw err;
  }
  return data.result;
}

function describe(a: Action): string {
  if ("Transfer" in a) return `pay ${a.Transfer.receiver} ${fromYocto(a.Transfer.amount)} NEAR`;
  if ("FtTransfer" in a) return `send ${a.FtTransfer.amount} units of ${a.FtTransfer.token} to ${a.FtTransfer.receiver}`;
  if ("IntentsDeposit" in a) {
    const d = a.IntentsDeposit;
    return `swap ${d.token ? d.amount + " units of " + d.token : fromYocto(d.amount) + " NEAR"} to ${d.destination_asset} for ${d.recipient}`;
  }
  return `call ${a.FunctionCall.contract}.${a.FunctionCall.method} with ${fromYocto(a.FunctionCall.deposit)} NEAR attached`;
}

async function main() {
  const owner = await BoundOwner.load(NETWORK, OWNER!, WALLET!);
  const notified = new Set<number>();
  let updateOffset = 0;
  console.log(`approvals bot up: ${WALLET} (${NETWORK}), owner ${OWNER}`);
  if (!CHAT) console.log("TELEGRAM_CHAT_ID not set — send the bot any message and I'll print your chat id.");

  // Watch the queue.
  const watch = async () => {
    for (;;) {
      try {
        const pending = await owner.getPending();
        for (const p of pending as PendingAction[]) {
          if (notified.has(p.id) || !CHAT) continue;
          notified.add(p.id);
          await tg("sendMessage", {
            chat_id: CHAT,
            text: `🔔 ${WALLET}\nAgent asks to ${describe(p.action)}\nrequest #${p.id}`,
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Approve", callback_data: `approve:${p.id}` },
                { text: "❌ Reject", callback_data: `reject:${p.id}` },
              ]],
            },
          });
          console.log(`notified #${p.id}: ${describe(p.action)}`);
        }
      } catch (e: any) {
        console.error(`queue poll failed: ${e?.message ?? e}`);
      }
      await new Promise((r) => setTimeout(r, POLL_SECS * 1000));
    }
  };

  // Listen for taps.
  const listen = async () => {
    for (;;) {
      try {
        const updates = (await tg("getUpdates", { offset: updateOffset, timeout: 25 })) ?? [];
        for (const u of updates) {
          updateOffset = u.update_id + 1;
          if (u.message && !CHAT) {
            console.log(`your chat id is ${u.message.chat.id} — restart with TELEGRAM_CHAT_ID=${u.message.chat.id}`);
            continue;
          }
          const q = u.callback_query;
          if (!q) continue;
          if (String(q.message?.chat?.id) !== String(CHAT)) {
            await tg("answerCallbackQuery", { callback_query_id: q.id, text: "not your wallet" });
            continue;
          }
          const [verb, idStr] = String(q.data).split(":");
          const id = Number(idStr);
          await tg("answerCallbackQuery", { callback_query_id: q.id, text: `${verb}ing #${id}…` });
          let outcome: string;
          try {
            if (verb === "approve") {
              // A policy with dollar caps re-checks the price on approval and
              // panics if it has gone stale, which it will whenever the owner
              // takes longer to tap than the freshness window. Pull a fresh
              // one first; it only costs gas and is a no-op on a manual source.
              await owner.refreshPrice().catch(() => {});
              const r = await owner.approve(id);
              outcome =
                r === "Executed" || (r && typeof r === "object" && !("Denied" in r))
                  ? `✅ #${id} approved and executed`
                  : `⛔ #${id} re-check denied: ${(r as any)?.Denied?.reason ?? JSON.stringify(r)}`;
            } else {
              await owner.reject(id);
              outcome = `❌ #${id} rejected`;
            }
          } catch (e: any) {
            outcome = `#${id} failed: ${String(e?.message ?? e).slice(0, 140)}`;
          }
          await tg("editMessageText", {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            text: `${q.message.text}\n\n${outcome}`,
          });
          console.log(outcome);
        }
      } catch (e: any) {
        console.error(`update poll failed: ${e?.message ?? e}`);
        if (e?.fatal) {
          console.error("that token is not valid. Check TELEGRAM_BOT_TOKEN against @BotFather.");
          process.exit(1);
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };

  await Promise.all([watch(), listen()]);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
