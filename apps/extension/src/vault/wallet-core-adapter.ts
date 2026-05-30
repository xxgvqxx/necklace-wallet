/**
 * wallet-core adapter — the bridge between the vault and `@necklace/wallet-core`.
 *
 * Implements the vault's `AddressDeriver` seam (derive + generate) and the
 * import-parsing the dispatcher needs, all backed by the audited TS port of
 * Pearl's Schnorr/Taproot crypto. The vault package itself never imports
 * wallet-core directly; the worker wires this adapter at startup
 * (`service-worker.ts` -> `setAddressDeriver`).
 *
 * NETWORK MODEL
 * -------------
 * A vault commits only to a coarse `VaultChain` (mainnet vs testnet). The
 * fine-grained `Network` (regtest/testnet/…/mainnet) that selects HRP, WIF netID
 * and BIP-86 coin type is the build's `ACTIVE_NETWORK`. We resolve a `VaultChain`
 * to the precise `Network` here so derive/generate/sign all agree on one network
 * for the lifetime of the build.
 *
 * STEP 0 (verified live against Oyster on simnet): Oyster uses PLAIN BIP-86 P2TR
 * (empty tapscript root) for receive addresses — a dumped WIF re-derives the
 * exact address Oyster reported. So derive and sign both use plain BIP-86 with no
 * commitment tweak; imports are safe.
 *
 * SECURITY: never logs the secret, key bytes, or mnemonic.
 */

import {
  deriveAddress,
  deriveBip86AddressFromMnemonic,
  deriveBip86AddressFromXpub,
  deriveBip86KeyFromMnemonic,
  decodeAddress,
  importPrivateKey,
  generateMnemonic,
  isValidMnemonic,
  buildTransaction,
  addWalletFeeOutput,
  signTransaction,
  serializeTxHex,
  computeTxid,
  type SelectedInput,
  type SigningInput,
  type WireTx,
  KeyImportError,
  HdError,
} from "@necklace/wallet-core";
import type {
  DerivedAddress,
  KeyImportKind,
  Network,
  SignedTx,
  TxDraft,
} from "@necklace/shared";
import { ACTIVE_NETWORK } from "../api/config.js";
import type { AddressDeriver, DerivedIdentity, GeneratedWallet } from "./derive.js";
import type { SignRequest, TransactionSigner } from "./signer.js";
import type { DecryptedSecret, VaultChain } from "./vault-types.js";
import { InvalidKeyError, SignFailedError, WatchOnlyError } from "./errors.js";

/** Canonical fine `Network` per coarse chain when the build network disagrees. */
const CANONICAL_NETWORK_BY_CHAIN: Record<VaultChain, Network> = {
  "pearl-mainnet": "mainnet",
  "pearl-testnet": "testnet",
};

/** True if a fine `Network` belongs to the coarse `VaultChain` family. */
export function networkInChain(network: Network, chain: VaultChain): boolean {
  const isMain = network === "mainnet";
  return chain === "pearl-mainnet" ? isMain : !isMain;
}

/** Map the build's `ACTIVE_NETWORK` to the vault chain it must be stored under. */
export function chainForActiveNetwork(): VaultChain {
  return ACTIVE_NETWORK === "mainnet" ? "pearl-mainnet" : "pearl-testnet";
}

/**
 * Resolve the precise `Network` to derive/sign with for a vault chain. Prefers
 * the build's `ACTIVE_NETWORK` when it belongs to the chain (so a regtest dev
 * build derives `rprl` addresses), else the canonical network for the chain.
 */
export function resolveNetwork(chain: VaultChain): Network {
  if (networkInChain(ACTIVE_NETWORK, chain)) return ACTIVE_NETWORK;
  return CANONICAL_NETWORK_BY_CHAIN[chain];
}

/** Decode a stored bech32m address string into a UI-facing `DerivedAddress`. */
export function toDerivedAddress(address: string, network: Network): DerivedAddress {
  const decoded = decodeAddress(address);
  return {
    network,
    address,
    witnessVersion: decoded.witnessVersion,
    witnessProgramHex: bytesToHex(decoded.program),
  };
}

/**
 * Parse the UI's import payload into a `DecryptedSecret` the vault can encrypt.
 * Keeps all WIF/hex/xpub/mnemonic parsing in wallet-core; the UI stays thin.
 *
 * @throws InvalidKeyError on any malformed input (mapped to INVALID_KEY).
 */
export function parseImport(
  kind: KeyImportKind,
  secret: string,
  mnemonicPassphrase?: string,
): DecryptedSecret {
  const value = secret.trim();
  try {
    switch (kind) {
      case "wif":
      case "rawHex": {
        const imported = importPrivateKey(value);
        return {
          kind: "secp256k1-privkey",
          privateKeyHex: bytesToHex(imported.privateKey),
        };
      }
      case "mnemonic": {
        if (!isValidMnemonic(value)) {
          throw new InvalidKeyError("invalid BIP-39 mnemonic");
        }
        return {
          kind: "bip39-mnemonic",
          mnemonic: value,
          ...(mnemonicPassphrase ? { passphrase: mnemonicPassphrase } : {}),
        };
      }
      case "xpub":
      case "watchOnly": {
        // Validate it decodes to a usable account xpub on this network before
        // committing it (so a bad xpub fails at import, not at first use).
        deriveBip86AddressFromXpub(value, resolveNetwork(chainForActiveNetwork()), {
          change: 0,
          index: 0,
        });
        return { kind: "watch-only-xpub", xpub: value };
      }
      default: {
        const _never: never = kind;
        throw new InvalidKeyError(`unsupported import kind: ${String(_never)}`);
      }
    }
  } catch (err) {
    if (err instanceof InvalidKeyError) throw err;
    if (err instanceof KeyImportError || err instanceof HdError) {
      throw new InvalidKeyError(err.message);
    }
    throw err;
  }
}

/** Derive the controlling 32-byte secp256k1 key for a signable secret. */
export function deriveControllingKey(
  secret: DecryptedSecret,
  network: Network,
): Uint8Array {
  switch (secret.kind) {
    case "secp256k1-privkey":
      return hexToBytes(secret.privateKeyHex);
    case "bip39-mnemonic": {
      const k = deriveBip86KeyFromMnemonic(
        secret.mnemonic,
        network,
        {},
        secret.passphrase,
      );
      return k.privateKey;
    }
    case "watch-only-xpub":
      throw new InvalidKeyError("watch-only vault has no controlling key");
  }
}

/** The deriver wired into the vault at worker startup. */
export const walletCoreDeriver: AddressDeriver = {
  async derive(secret: DecryptedSecret, chain: VaultChain): Promise<DerivedIdentity> {
    const network = resolveNetwork(chain);
    switch (secret.kind) {
      case "secp256k1-privkey": {
        const imported = importPrivateKey(secret.privateKeyHex);
        const addr = deriveAddress(imported.privateKey, network);
        return {
          address: addr.address,
          publicKeyHex: bytesToHex(imported.xOnlyPublicKey),
        };
      }
      case "bip39-mnemonic": {
        const k = deriveBip86KeyFromMnemonic(secret.mnemonic, network, {}, secret.passphrase);
        const addr = deriveAddress(k.privateKey, network);
        return {
          address: addr.address,
          publicKeyHex: bytesToHex(k.xOnlyPublicKey),
        };
      }
      case "watch-only-xpub": {
        const addr = deriveBip86AddressFromXpub(secret.xpub, network, { change: 0, index: 0 });
        return {
          address: addr.address,
          publicKeyHex: addr.witnessProgramHex,
        };
      }
    }
  },

  async generate(chain: VaultChain): Promise<GeneratedWallet> {
    const network = resolveNetwork(chain);
    // Generate a fresh BIP-39 mnemonic (12 words) — safe in-browser per
    // protocol-findings: it is stateless secp256k1/BIP-86 material; no XMSS.
    const mnemonic = generateMnemonic(12);
    const key = deriveBip86KeyFromMnemonic(mnemonic, network);
    const addr = deriveBip86AddressFromMnemonic(mnemonic, network);
    return {
      secret: { kind: "bip39-mnemonic", mnemonic },
      identity: {
        address: addr.address,
        publicKeyHex: bytesToHex(key.xOnlyPublicKey),
      },
    };
  },
};

/**
 * The transaction signer wired into the vault at worker startup.
 *
 * SIGN-WHAT-YOU-SEE: outputs are built ONLY from the approved `TxDraft` in the
 * canonical order [recipients…, necklaceFee, change]. Before any signature is
 * released we assert the built tx's (scriptPubKey,value) output multiset equals
 * the draft's declared outputs and that Σinputs − Σoutputs equals
 * `draft.minerFee`. A backend that lies about a UTXO value therefore cannot
 * redirect a payment: the outputs are fixed by the draft, and a wrong prevValue
 * only yields a signature that fails BIP-341 verification (prevValue is
 * committed in the sighash).
 */
export const walletCoreSigner: TransactionSigner = {
  async sign(request: SignRequest): Promise<SignedTx> {
    try {
      return signDraftWithKey(request);
    } catch (err) {
      // Preserve typed vault errors (WATCH_ONLY / SIGN_FAILED); wrap the rest.
      if (err instanceof SignFailedError || err instanceof WatchOnlyError) throw err;
      throw new SignFailedError(err instanceof Error ? err.message : "signing failed");
    }
  },
};

function signDraftWithKey(request: SignRequest): SignedTx {
  const { draft, secret, network } = request;

  if (secret.kind === "watch-only-xpub") {
    throw new WatchOnlyError("watch-only vault cannot sign");
  }
  if (draft.inputs.length === 0) {
    throw new SignFailedError("draft has no inputs");
  }
  if (draft.recipients.length === 0) {
    throw new SignFailedError("draft has no recipients");
  }

  // Derive the single controlling key + its x-only internal pubkey.
  const privateKey = deriveControllingKey(secret, network);
  const xOnlyPublicKey = importPrivateKey(bytesToHex(privateKey)).xOnlyPublicKey;

  // Inputs: single-key MVP — every input is controlled by the same key.
  const selected: SelectedInput[] = draft.inputs.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    scriptPubKeyHex: u.scriptPubKeyHex,
    tapInternalKey: xOnlyPublicKey,
    tapMerkleRoot: null, // plain BIP-86 (STEP 0: matches Oyster)
  }));

  // Outputs strictly from the approved draft, in canonical order.
  const recipientSpecs = draft.recipients.map((r) => ({ address: r.address, value: r.value }));
  let built = buildTransaction(
    recipientSpecs,
    selected,
    draft.change?.address,
    draft.change?.value ?? 0n,
  );
  if (draft.necklaceFee) {
    built = addWalletFeeOutput(built, draft.necklaceFee.address, draft.necklaceFee.value);
  }

  // ── Sign-what-you-see assertions (BEFORE signing) ──────────────────────────
  assertOutputsMatchDraft(built.tx, draft);
  assertFeeMatchesDraft(built.tx, draft);

  // Sign every input with the single controlling key (BIP-86 tweak applied
  // inside wallet-core; empty merkle root).
  const signed = signTransaction(
    built.tx,
    built.signingInputs as readonly SigningInput[],
    () => privateKey,
  );

  return {
    txid: computeTxid(signed),
    rawHex: serializeTxHex(signed, true),
  };
}

/** Assert the built tx's (scriptPubKey,value) output multiset equals the draft. */
function assertOutputsMatchDraft(tx: WireTx, draft: TxDraft): void {
  const declared: Array<{ address: string; value: bigint }> = [
    ...draft.recipients.map((r) => ({ address: r.address, value: r.value })),
    ...(draft.necklaceFee ? [{ address: draft.necklaceFee.address, value: draft.necklaceFee.value }] : []),
    ...(draft.change ? [{ address: draft.change.address, value: draft.change.value }] : []),
  ];
  const declaredScripts = declared.map((d) => ({
    script: bytesToHex(decodeAddress(d.address).scriptPubKey),
    value: d.value,
  }));
  const builtScripts = tx.outputs.map((o) => ({
    script: bytesToHex(o.pkScript),
    value: o.value,
  }));

  if (builtScripts.length !== declaredScripts.length) {
    throw new SignFailedError(
      `output count mismatch: built ${builtScripts.length}, approved ${declaredScripts.length}`,
    );
  }
  const key = (e: { script: string; value: bigint }): string => `${e.script}:${e.value}`;
  const want = sortedKeys(declaredScripts.map(key));
  const have = sortedKeys(builtScripts.map(key));
  for (let i = 0; i < want.length; i++) {
    if (want[i] !== have[i]) {
      throw new SignFailedError("built outputs do not match the approved draft");
    }
  }
}

/** Assert Σinputs − Σoutputs (from the draft's stated input values) == draft.minerFee. */
function assertFeeMatchesDraft(tx: WireTx, draft: TxDraft): void {
  const totalIn = draft.inputs.reduce((acc, u) => acc + u.value, 0n);
  const totalOut = tx.outputs.reduce((acc, o) => acc + o.value, 0n);
  const impliedFee = totalIn - totalOut;
  if (impliedFee < 0n) {
    throw new SignFailedError("outputs exceed inputs (negative miner fee)");
  }
  if (impliedFee !== draft.minerFee) {
    throw new SignFailedError(
      `miner fee mismatch: implied ${impliedFee} Grain, approved ${draft.minerFee} Grain`,
    );
  }
}

function sortedKeys(keys: string[]): string[] {
  return [...keys].sort();
}

// --- byte helpers (no Buffer; works in the service worker + node test env) ---

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new InvalidKeyError("invalid private key hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
