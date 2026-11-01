/**
 * Who signs owner transactions. Two implementations:
 *  - WalletSigner: a real NEAR wallet via wallet-selector (MyNearWallet, Meteor).
 *  - DevKeySigner: a private key pasted into the app. Testnet-only convenience
 *    for development and demos; the key lives in localStorage on this device.
 */
import { connect, keyStores, KeyPair, type Account } from "near-api-js";
import { actionCreators } from "@near-js/transactions";
import type { WalletSelector } from "@near-wallet-selector/core";
import { RPC, type Network } from "./rpc";

export interface Signer {
  kind: "wallet" | "devkey";
  accountId: string;
  call(contractId: string, method: string, args: object, gasTgas?: number): Promise<any>;
  signOut(): Promise<void>;
}

const tgas = (n: number) => BigInt(n) * 1_000_000_000_000n;

export class WalletSigner implements Signer {
  kind = "wallet" as const;
  accountId: string;
  private selector: WalletSelector;

  constructor(selector: WalletSelector, accountId: string) {
    this.selector = selector;
    this.accountId = accountId;
  }

  async call(contractId: string, method: string, args: object, gasTgas = 100) {
    const wallet = await this.selector.wallet();
    return wallet.signAndSendTransaction({
      receiverId: contractId,
      actions: [actionCreators.functionCall(method, args, tgas(gasTgas), 0n)],
    });
  }

  async signOut() {
    const wallet = await this.selector.wallet();
    await wallet.signOut();
  }
}

export class DevKeySigner implements Signer {
  kind = "devkey" as const;
  accountId: string;
  private account: Promise<Account>;

  constructor(network: Network, accountId: string, secretKey: string) {
    this.accountId = accountId;
    const keyStore = new keyStores.InMemoryKeyStore();
    this.account = (async () => {
      await keyStore.setKey(network, accountId, KeyPair.fromString(secretKey as any));
      const near = await connect({ networkId: network, nodeUrl: RPC[network], keyStore });
      return near.account(accountId);
    })();
  }

  async call(contractId: string, method: string, args: object, gasTgas = 100) {
    const acc = await this.account;
    return acc.functionCall({ contractId, methodName: method, args, gas: tgas(gasTgas) });
  }

  async signOut() {
    localStorage.removeItem("bound.devkey");
  }
}

export function generateAgentKey(): { publicKey: string; secretKey: string } {
  const kp = KeyPair.fromRandom("ed25519");
  return { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
}

/** Public key for a secret key, used to validate pasted dev keys. */
export function publicKeyOf(secretKey: string): string {
  return KeyPair.fromString(secretKey as any).getPublicKey().toString();
}
