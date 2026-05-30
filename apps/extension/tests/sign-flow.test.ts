/**
 * Worker sign-flow integration: the REAL wallet-core deriver + signer wired
 * through the vault manager + dispatcher (no stubs), proving the send flow is
 * wired end-to-end and that the sign-what-you-see assertions in the worker fail
 * closed.
 *
 * Runs in the vitest `node` env (real WebCrypto + in-memory storage). The build's
 * ACTIVE_NETWORK is regtest, so derive/sign use the `rprl` network.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __setStorageBackend, loadVaultFile, type StorageBackend } from "../src/vault/storage.js";
import { __resetSession } from "../src/vault/session.js";
import { importSecret, signDraft } from "../src/vault/manager.js";
import { setAddressDeriver } from "../src/vault/derive.js";
import { setTransactionSigner } from "../src/vault/signer.js";
import { walletCoreDeriver, walletCoreSigner } from "../src/vault/wallet-core-adapter.js";
import { SignFailedError } from "../src/vault/errors.js";
import { handleMessage } from "../src/background/dispatch.js";
import {
  deriveAddress,
  importPrivateKey,
  serializeTxHex,
  computeTxid,
  signTransaction,
  buildTransaction,
  addWalletFeeOutput,
  type SelectedInput,
} from "@necklace/wallet-core";
import type { TxDraft } from "@necklace/shared";

function makeMemoryBackend(): StorageBackend {
  const store = new Map<string, string>();
  return {
    async get(key) {
      const v = store.get(key);
      return v === undefined ? undefined : JSON.parse(v);
    },
    async set(key, value) {
      store.set(key, JSON.stringify(value));
    },
    async remove(key) {
      store.delete(key);
    },
  };
}

// A real regtest key + its owned UTXO + a real recipient/fee/change address.
const PRIV_HEX = "ef".repeat(32);
const imported = importPrivateKey(PRIV_HEX);
const OWNER = deriveAddress(imported.privateKey, "regtest");
const OWNER_SCRIPT_HEX = `5120${OWNER.witnessProgramHex}`;
const RECIPIENT = deriveAddress(
  Uint8Array.from({ length: 32 }, (_, i) => ((i * 11) % 255) + 1),
  "regtest",
).address;
const FEE_ADDR = deriveAddress(
  Uint8Array.from({ length: 32 }, (_, i) => ((i * 7) % 255) + 1),
  "regtest",
).address;
const CHANGE_ADDR = deriveAddress(
  Uint8Array.from({ length: 32 }, (_, i) => ((i * 3) % 255) + 1),
  "regtest",
).address;

const INPUT_VALUE = 500_000_000n;
const RECIPIENT_VALUE = 200_000_000n;
const FEE_VALUE = 1_000_000n;
const CHANGE_VALUE = 298_850_000n;
const MINER_FEE = INPUT_VALUE - RECIPIENT_VALUE - FEE_VALUE - CHANGE_VALUE; // 150000

function makeDraft(overrides: Partial<TxDraft> = {}): TxDraft {
  return {
    network: "regtest",
    inputs: [
      {
        txid: "11".repeat(32),
        vout: 0,
        value: INPUT_VALUE,
        scriptPubKeyHex: OWNER_SCRIPT_HEX,
      },
    ],
    recipients: [{ address: RECIPIENT, value: RECIPIENT_VALUE }],
    change: { address: CHANGE_ADDR, value: CHANGE_VALUE },
    necklaceFee: { address: FEE_ADDR, value: FEE_VALUE },
    minerFee: MINER_FEE,
    ...overrides,
  };
}

beforeEach(() => {
  __setStorageBackend(makeMemoryBackend());
  __resetSession();
  setAddressDeriver(walletCoreDeriver);
  setTransactionSigner(walletCoreSigner);
});

afterEach(() => {
  __resetSession();
  __setStorageBackend(null);
});

describe("end-to-end signing with the real wallet-core signer", () => {
  it("imports a raw key and produces a valid signed tx that matches a hand-built one", async () => {
    await importSecret("e2e-sign-pass-1", "pearl-testnet", {
      kind: "secp256k1-privkey",
      privateKeyHex: PRIV_HEX,
    });

    const signed = await signDraft("e2e-sign-pass-1", makeDraft(), "regtest");

    // Independently build + sign the same tx and compare (deterministic auxRand
    // is the default 32 zero bytes inside signTransaction).
    const selected: SelectedInput[] = [
      {
        txid: "11".repeat(32),
        vout: 0,
        value: INPUT_VALUE,
        scriptPubKeyHex: OWNER_SCRIPT_HEX,
        tapInternalKey: imported.xOnlyPublicKey,
        tapMerkleRoot: null,
      },
    ];
    const built = addWalletFeeOutput(
      buildTransaction(
        [{ address: RECIPIENT, value: RECIPIENT_VALUE }],
        selected,
        CHANGE_ADDR,
        CHANGE_VALUE,
      ),
      FEE_ADDR,
      FEE_VALUE,
    );
    const expectedTx = signTransaction(built.tx, built.signingInputs, () => imported.privateKey);
    expect(signed.rawHex).toBe(serializeTxHex(expectedTx, true));
    expect(signed.txid).toBe(computeTxid(expectedTx));
  });

  it("signs through the dispatcher (SIGN_TX -> SIGNED_TX)", async () => {
    await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "rawHex", secret: PRIV_HEX, password: "dispatch-sign-pass" },
    });
    const res = await handleMessage({
      type: "SIGN_TX",
      draft: makeDraft(),
      password: "dispatch-sign-pass",
    });
    expect(res.type).toBe("SIGNED_TX");
    if (res.type === "SIGNED_TX") {
      expect(res.signed.rawHex).toMatch(/^[0-9a-f]+$/);
      expect(res.signed.txid).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("sign-what-you-see assertions fail closed (SIGN_FAILED)", () => {
  it("rejects a draft whose minerFee does not match inputs - outputs", async () => {
    await importSecret("fee-mismatch-pass", "pearl-testnet", {
      kind: "secp256k1-privkey",
      privateKeyHex: PRIV_HEX,
    });
    // Claim a wrong miner fee; real inputs-outputs is 150000.
    const bad = makeDraft({ minerFee: 999_999n });
    await expect(signDraft("fee-mismatch-pass", bad, "regtest")).rejects.toBeInstanceOf(
      SignFailedError,
    );
  });

  it("dispatcher surfaces a fee mismatch as ERROR{code:SIGN_FAILED}", async () => {
    await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "rawHex", secret: PRIV_HEX, password: "fee-mismatch-disp" },
    });
    const res = await handleMessage({
      type: "SIGN_TX",
      draft: makeDraft({ minerFee: 1n }),
      password: "fee-mismatch-disp",
    });
    expect(res.type).toBe("ERROR");
    if (res.type === "ERROR") expect(res.code).toBe("SIGN_FAILED");
  });

  it("signs the SAME outputs regardless of a lied input value (only the fee check trips)", async () => {
    await importSecret("lied-value-pass", "pearl-testnet", {
      kind: "secp256k1-privkey",
      privateKeyHex: PRIV_HEX,
    });
    // Backend lies: claims the input is worth less than it is. The draft's
    // minerFee was computed from the true value, so the assertion catches the
    // inconsistency and refuses — the payment is never built with redirected
    // outputs.
    const lied = makeDraft({
      inputs: [
        {
          txid: "11".repeat(32),
          vout: 0,
          value: 400_000_000n, // lied (true is 500_000_000)
          scriptPubKeyHex: OWNER_SCRIPT_HEX,
        },
      ],
      // minerFee still claims 150000 (computed from the true value).
    });
    await expect(signDraft("lied-value-pass", lied, "regtest")).rejects.toBeInstanceOf(
      SignFailedError,
    );
  });
});

describe("watch-only cannot sign", () => {
  it("rejects signing for a watch-only vault with WATCH_ONLY", async () => {
    // A real account xpub (BIP-86 m/86'/1'/0' from the abandon mnemonic).
    const xpub =
      "xpub6DJJUToomnxLc192dPF1RhY1YYYrc5BhnvoQmnM5CZH4ygBqaYWaMrNMLThrkYwsRGsjn3x5Aj9Yt8vrkDyUCwuBpjdscoqAqsPq2kz4rf8";
    await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "watchOnly", secret: xpub, password: "watch-only-e2e-pw" },
    });
    const file = await loadVaultFile();
    expect(file?.accounts[0]?.watchOnly).toBe(true);
    const res = await handleMessage({
      type: "SIGN_TX",
      draft: makeDraft(),
      password: "watch-only-e2e-pw",
    });
    expect(res.type).toBe("ERROR");
    if (res.type === "ERROR") expect(res.code).toBe("WATCH_ONLY");
  });
});
