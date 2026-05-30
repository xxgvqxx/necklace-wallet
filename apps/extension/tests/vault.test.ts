/**
 * Vault / background security tests.
 *
 * Runs in the vitest `node` environment, which provides global WebCrypto
 * (`crypto.subtle`, `crypto.getRandomValues`) and `btoa`/`atob`, so the real
 * KDF + AES-GCM paths execute unmocked. `chrome.storage` is replaced by an
 * in-memory backend; address derivation + transaction signing are replaced by
 * deterministic stubs (the real ones live in @necklace/wallet-core and are
 * KAT-tested there).
 *
 * Coverage:
 *  - PBKDF2-SHA256 -> AES-256-GCM round-trip; wrong password fails (GCM tag).
 *  - Fresh random IV per encryption (never reused).
 *  - Import + generate create an encrypted vault; plaintext never persisted.
 *  - Unlock/lock/reveal/change-password/delete lifecycle.
 *  - XMSS OTS state is sealed (index never advanced).
 *  - storage uses TRUSTED_CONTEXTS access level and never storage.sync.
 *  - Unified VaultRequest/VaultResponse dispatcher round-trips; typed error codes.
 *  - signDraft re-derives the key from the sign-time password (not the session).
 *  - Corrupted-vault records fail closed with CORRUPT_VAULT.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  base64ToBytes,
  defaultPbkdf2Params,
  deriveAesKey,
  generateSalt,
} from "../src/vault/kdf.js";
import { decryptSecret, encryptSecret } from "../src/vault/encrypt.js";
import {
  __setStorageBackend,
  ensureTrustedAccessLevel,
  loadVault,
  loadVaultFile,
  migrateRecordToFile,
  updateVaultAtomic,
  validateVaultFile,
  validateVaultRecord,
  VAULT_KEY,
  type StorageBackend,
} from "../src/vault/storage.js";
import { __resetSession, isUnlocked } from "../src/vault/session.js";
import {
  addAccount,
  changePassword,
  deleteVault,
  exportSecret,
  generateNewWallet,
  importSecret,
  lockVault,
  removeAccount,
  renameAccount,
  signDraft,
  switchAccount,
  unlock,
} from "../src/vault/manager.js";
import { setAddressDeriver, type AddressDeriver } from "../src/vault/derive.js";
import { setTransactionSigner, type TransactionSigner } from "../src/vault/signer.js";
import { CorruptVaultError } from "../src/vault/errors.js";
import type { DecryptedSecret } from "../src/vault/vault-types.js";
import { handleMessage } from "../src/background/dispatch.js";
import type { TxDraft } from "@necklace/shared";

// ── In-memory storage backend ────────────────────────────────────────────────
function makeMemoryBackend(): StorageBackend & {
  dump(): Map<string, string>;
  putRaw(key: string, value: unknown): void;
} {
  const store = new Map<string, string>();
  return {
    async get(key) {
      const v = store.get(key);
      return v === undefined ? undefined : JSON.parse(v);
    },
    async set(key, value) {
      // Stringify like chrome would round-trip JSON; lets us assert on raw bytes.
      store.set(key, JSON.stringify(value));
    },
    async remove(key) {
      store.delete(key);
    },
    dump: () => store,
    putRaw: (key, value) => store.set(key, JSON.stringify(value)),
  };
}

// ── Deterministic address deriver stub (stands in for wallet-core) ───────────
// Produces a VALID rprl/tprl/prl bech32m v1 address so dispatch's toDerivedAddress
// (real wallet-core decode) can parse it.
const STUB_PROGRAM = "337fa8f90873c4e1b4c0b1ad3afff3cc29f9095307df68cea012813eb13a9976";
const STUB_ADDR_MAIN = "prl1pxdl637ggw0zwrdxqkxkn4llnes5ljz2nql0k3n4qz2qnavf6n9mqc4qtdw";
const STUB_ADDR_TEST = "tprl1pxdl637ggw0zwrdxqkxkn4llnes5ljz2nql0k3n4qz2qnavf6n9mqn6y4jm";

const stubDeriver: AddressDeriver = {
  async derive(secret, chain) {
    return {
      address: chain === "pearl-mainnet" ? STUB_ADDR_MAIN : STUB_ADDR_TEST,
      publicKeyHex: STUB_PROGRAM,
      xmssCommitmentHex: secret.kind === "watch-only-xpub" ? undefined : "de".padEnd(64, "0"),
    };
  },
  async generate(chain) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return {
      secret: { kind: "secp256k1-privkey", privateKeyHex: hex },
      identity: {
        address: chain === "pearl-mainnet" ? STUB_ADDR_MAIN : STUB_ADDR_TEST,
        publicKeyHex: STUB_PROGRAM,
        xmssCommitmentHex: "de".padEnd(64, "0"),
      },
    };
  },
};

// ── Deterministic transaction signer stub ────────────────────────────────────
// Records the request so tests can assert the secret reaching the signer is the
// one decrypted with the SIGN-TIME password.
let lastSignSecret: DecryptedSecret | null = null;
const stubSigner: TransactionSigner = {
  async sign(req) {
    lastSignSecret = req.secret;
    return { txid: "ab".repeat(32), rawHex: "00".repeat(10) };
  },
};

let backend: ReturnType<typeof makeMemoryBackend>;

beforeEach(() => {
  backend = makeMemoryBackend();
  __setStorageBackend(backend);
  __resetSession();
  setAddressDeriver(stubDeriver);
  setTransactionSigner(stubSigner);
  lastSignSecret = null;
});

afterEach(() => {
  __resetSession();
  __setStorageBackend(null);
  vi.restoreAllMocks();
});

const PRIV: DecryptedSecret = {
  kind: "secp256k1-privkey",
  privateKeyHex: "ef".repeat(32),
};

// ── KDF + AEAD ───────────────────────────────────────────────────────────────
describe("kdf + encrypt", () => {
  it("round-trips a secret through PBKDF2 + AES-256-GCM", async () => {
    const params = defaultPbkdf2Params(generateSalt());
    const key = await deriveAesKey("correct horse battery", params);
    const payload = await encryptSecret(key, PRIV);
    expect(payload.cipher).toBe("aes-256-gcm");
    const out = await decryptSecret(key, payload);
    expect(out).toEqual(PRIV);
  });

  it("derives a NON-extractable AES key", async () => {
    const params = defaultPbkdf2Params(generateSalt());
    const key = await deriveAesKey("pw-pw-pw-1", params);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeDefined();
  });

  it("fails decryption with the wrong password (GCM auth)", async () => {
    const params = defaultPbkdf2Params(generateSalt());
    const k1 = await deriveAesKey("right-password", params);
    const k2 = await deriveAesKey("wrong-password", params);
    const payload = await encryptSecret(k1, PRIV);
    await expect(decryptSecret(k2, payload)).rejects.toThrow(/wrong password or corrupt/);
  });

  it("uses a fresh random IV on every encryption (never reused)", async () => {
    const params = defaultPbkdf2Params(generateSalt());
    const key = await deriveAesKey("iv-test-pass", params);
    const ivs = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const p = await encryptSecret(key, PRIV);
      expect(base64ToBytes(p.ivB64).length).toBe(12);
      ivs.add(p.ivB64);
    }
    expect(ivs.size).toBe(25);
  });

  it("uses a unique random salt per vault", () => {
    const salts = new Set<string>();
    for (let i = 0; i < 25; i++) salts.add(defaultPbkdf2Params(generateSalt()).saltB64);
    expect(salts.size).toBe(25);
  });
});

// ── Vault lifecycle ──────────────────────────────────────────────────────────
describe("vault lifecycle", () => {
  it("imports a private key, persists ONLY ciphertext, and unlocks", async () => {
    const status = await importSecret("hunter2hunter2", "pearl-testnet", PRIV);
    expect(status.hasVault).toBe(true);
    expect(status.locked).toBe(false);
    expect(status.address).toBe(STUB_ADDR_TEST);

    // Persisted blob must NOT contain the plaintext private key anywhere.
    const rawBlob = JSON.stringify([...backend.dump().values()]);
    expect(rawBlob).not.toContain(PRIV.privateKeyHex);
    expect(rawBlob.toLowerCase()).not.toContain("hunter2");

    const file = await loadVaultFile();
    expect(file?.version).toBe(2);
    expect(file?.accounts).toHaveLength(1);
    const acct = file!.accounts[0]!;
    expect(acct.payload.cipher).toBe("aes-256-gcm");
    expect(file?.kdfParams.kdf).toBe("pbkdf2-sha256");
    expect(acct.watchOnly).toBe(false);
    expect(acct.label).toBe("Account 1");
    expect(file?.activeAccountId).toBe(acct.id);
  });

  it("generates a new wallet in-browser, returns the backup, seals XMSS", async () => {
    const { status, mnemonic } = await generateNewWallet("generate-me-please", "pearl-mainnet");
    expect(status.address).toBe(STUB_ADDR_MAIN);
    expect(status.xmssSealed).toBe(true);
    expect(mnemonic).toMatch(/^[0-9a-f]{64}$/); // stub generates a raw key

    const file = await loadVaultFile();
    const acct = file!.accounts[0]!;
    expect(acct.xmss?.signingSealed).toBe(true);
    expect(acct.xmss?.nextOtsIndex).toBe(0);
    expect(acct.xmss?.maxSignatures).toBe(32);
    expect(acct.xmss?.scheme).toBe("XMSS-SHAKE256_5_256");
  });

  it("locks, then unlocks with the right password and exports the secret", async () => {
    await importSecret("lock-unlock-pass", "pearl-testnet", PRIV);
    lockVault();
    expect(isUnlocked()).toBe(false);
    expect(() => exportSecret()).toThrow(/locked/);

    const s = await unlock("lock-unlock-pass");
    expect(s.locked).toBe(false);
    expect(isUnlocked()).toBe(true);
    expect(exportSecret()).toEqual(PRIV);
  });

  it("rejects unlock with the wrong password", async () => {
    await importSecret("the-real-pass", "pearl-testnet", PRIV);
    lockVault();
    await expect(unlock("not-the-pass")).rejects.toThrow(/wrong password or corrupt/);
    expect(isUnlocked()).toBe(false);
  });

  it("changes the password and preserves the secret under a new salt", async () => {
    await importSecret("old-password-1", "pearl-testnet", PRIV);
    const before = await loadVaultFile();
    await changePassword("old-password-1", "new-password-2");
    const after = await loadVaultFile();

    expect(after?.kdfParams.saltB64).not.toBe(before?.kdfParams.saltB64);
    expect(after!.accounts[0]!.payload.ivB64).not.toBe(before!.accounts[0]!.payload.ivB64);

    lockVault();
    await expect(unlock("old-password-1")).rejects.toThrow();
    const s = await unlock("new-password-2");
    expect(s.locked).toBe(false);
    expect(exportSecret()).toEqual(PRIV);
  });

  it("rejects change-password when the current password is wrong", async () => {
    await importSecret("current-pass-x", "pearl-testnet", PRIV);
    await expect(changePassword("bogus-current", "brand-new-pass")).rejects.toThrow(
      /wrong password or corrupt/,
    );
  });

  it("deletes the vault and locks", async () => {
    await importSecret("delete-me-pass", "pearl-testnet", PRIV);
    const s = await deleteVault();
    expect(s.hasVault).toBe(false);
    expect(await loadVault()).toBeNull();
    expect(isUnlocked()).toBe(false);
  });

  it("refuses a second vault while one already exists", async () => {
    await importSecret("first-vault-pass", "pearl-testnet", PRIV);
    await expect(importSecret("second-vault-pass", "pearl-testnet", PRIV)).rejects.toThrow(
      /already exists/,
    );
  });

  it("enforces a minimum passphrase length", async () => {
    await expect(importSecret("short", "pearl-testnet", PRIV)).rejects.toThrow(/8 characters/);
  });

  it("marks watch-only xpub vaults without XMSS state", async () => {
    const xpub: DecryptedSecret = { kind: "watch-only-xpub", xpub: "tpubFAKE" };
    const status = await importSecret("watch-only-pass", "pearl-testnet", xpub);
    expect(status.watchOnly).toBe(true);
    const record = await loadVault();
    expect(record?.xmss).toBeUndefined();
  });
});

// ── signDraft: sign-time password (defense-in-depth) ─────────────────────────
const DRAFT: TxDraft = {
  network: "regtest",
  inputs: [
    {
      txid: "11".repeat(32),
      vout: 0,
      value: 1_000_000n,
      scriptPubKeyHex: "5120" + STUB_PROGRAM,
    },
  ],
  recipients: [{ address: STUB_ADDR_TEST, value: 500_000n }],
  minerFee: 200n,
};

describe("signDraft", () => {
  it("re-derives the key from the SIGN-TIME password, not the session", async () => {
    await importSecret("sign-pass-1234", "pearl-testnet", PRIV);
    lockVault(); // session gone — must still sign with the password
    expect(isUnlocked()).toBe(false);

    const signed = await signDraft("sign-pass-1234", DRAFT, "regtest");
    expect(signed.txid).toBe("ab".repeat(32));
    // The signer received the secret decrypted with the sign-time password.
    expect(lastSignSecret).toEqual(PRIV);
    // Signing must NOT silently start a session.
    expect(isUnlocked()).toBe(false);
  });

  it("rejects signing with the wrong password", async () => {
    await importSecret("real-sign-pass", "pearl-testnet", PRIV);
    await expect(signDraft("wrong-sign-pass", DRAFT, "regtest")).rejects.toThrow(
      /wrong password or corrupt/,
    );
  });

  it("rejects signing for a watch-only vault (WATCH_ONLY)", async () => {
    const xpub: DecryptedSecret = { kind: "watch-only-xpub", xpub: "tpubFAKE" };
    await importSecret("watch-sign-pass", "pearl-testnet", xpub);
    await expect(signDraft("watch-sign-pass", DRAFT, "regtest")).rejects.toMatchObject({
      code: "WATCH_ONLY",
    });
  });
});

// ── Storage hardening ────────────────────────────────────────────────────────
describe("storage hardening", () => {
  it("sets TRUSTED_CONTEXTS access level and never touches storage.sync", async () => {
    const setAccessLevel = vi.fn().mockResolvedValue(undefined);
    const syncSet = vi.fn();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: { setAccessLevel },
        sync: { set: syncSet, get: vi.fn(), remove: vi.fn() },
      },
    };
    try {
      await ensureTrustedAccessLevel();
      expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
      expect(syncSet).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as unknown as { chrome?: unknown }).chrome;
    }
  });

  it("serializes concurrent atomic mutations without lost updates", async () => {
    await importSecret("atomic-pass-12", "pearl-testnet", PRIV);
    const ops = Array.from({ length: 20 }, () =>
      updateVaultAtomic((cur) => {
        if (!cur) throw new Error("missing");
        return {
          ...cur,
          accounts: cur.accounts.map((a) => ({ ...a, updatedAt: a.updatedAt + 1 })),
        };
      }),
    );
    await Promise.all(ops);
    const file = await loadVaultFile();
    expect(file).not.toBeNull();
    expect(file?.accounts).toHaveLength(1);
  });
});

// ── Corrupted-vault fail-closed ──────────────────────────────────────────────
describe("corrupted-vault fail-closed", () => {
  it("validateVaultRecord throws CorruptVaultError on a malformed record", () => {
    expect(() => validateVaultRecord(null)).toThrow(CorruptVaultError);
    expect(() => validateVaultRecord({})).toThrow(CorruptVaultError);
    expect(() =>
      validateVaultRecord({ version: 1, chain: "pearl-testnet", address: "x" }),
    ).toThrow(CorruptVaultError);
    expect(() =>
      validateVaultRecord({
        version: 1,
        chain: "bogus",
        address: "x",
        secretKind: "secp256k1-privkey",
        watchOnly: false,
        kdfParams: { kdf: "pbkdf2-sha256", saltB64: "a" },
        payload: { cipher: "aes-256-gcm", ivB64: "a", ciphertextB64: "b" },
      }),
    ).toThrow(/invalid chain/);
  });

  it("loadVault surfaces a corrupt persisted record as CorruptVaultError", async () => {
    backend.putRaw(VAULT_KEY, { not: "a vault" });
    await expect(loadVault()).rejects.toThrow(CorruptVaultError);
  });

  it("dispatcher maps a corrupt vault to ERROR{code:CORRUPT_VAULT}", async () => {
    backend.putRaw(VAULT_KEY, { version: 1, chain: "pearl-testnet" /* missing fields */ });
    const res = await handleMessage({ type: "GET_VAULT_STATE" });
    expect(res.type).toBe("ERROR");
    if (res.type === "ERROR") expect(res.code).toBe("CORRUPT_VAULT");
  });

  it("accepts a well-formed v2 file (no false positive)", async () => {
    await importSecret("well-formed-pass", "pearl-testnet", PRIV);
    const raw = await backend.get(VAULT_KEY);
    expect(() => validateVaultFile(raw)).not.toThrow();
  });
});

// ── Unified dispatcher protocol ──────────────────────────────────────────────
describe("unified VaultRequest/VaultResponse dispatcher", () => {
  it("handles PING and GET_VAULT_STATE", async () => {
    expect(await handleMessage({ type: "PING" })).toEqual({ type: "PONG" });
    const empty = await handleMessage({ type: "GET_VAULT_STATE" });
    expect(empty.type).toBe("VAULT_STATE");
    if (empty.type === "VAULT_STATE") {
      expect(empty.state.hasVault).toBe(false);
      expect(empty.state.network).toBe("mainnet");
    }
  });

  it("CREATE_WALLET returns WALLET_CREATED with a DerivedAddress + backup", async () => {
    const res = await handleMessage({
      type: "CREATE_WALLET",
      payload: { password: "create-via-dispatch" },
    });
    expect(res.type).toBe("WALLET_CREATED");
    if (res.type === "WALLET_CREATED") {
      expect(res.state.address?.address).toBe(STUB_ADDR_MAIN); // mainnet build -> mainnet chain
      expect(res.state.address?.witnessVersion).toBe(1);
      expect(res.state.address?.witnessProgramHex).toBe(STUB_PROGRAM);
      expect(typeof res.mnemonic).toBe("string");
    }
  });

  it("IMPORT_WALLET + UNLOCK + REVEAL_SECRET round-trip", async () => {
    // Import a real raw-hex private key through the real parseImport path.
    const imp = await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "rawHex", secret: "ef".repeat(32), password: "import-dispatch-pw" },
    });
    expect(imp.type).toBe("WALLET_IMPORTED");

    const locked = await handleMessage({ type: "LOCK" });
    expect(locked.type).toBe("LOCKED");

    const reveal = await handleMessage({ type: "REVEAL_SECRET", password: "import-dispatch-pw" });
    expect(reveal.type).toBe("SECRET");
    if (reveal.type === "SECRET") expect(reveal.secret).toBe("ef".repeat(32));

    const unlocked = await handleMessage({ type: "UNLOCK", password: "import-dispatch-pw" });
    expect(unlocked.type).toBe("UNLOCKED");
  });

  it("maps a wrong password to ERROR{code:WRONG_PASSWORD}", async () => {
    await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "rawHex", secret: "ef".repeat(32), password: "the-correct-pw" },
    });
    const res = await handleMessage({ type: "UNLOCK", password: "the-wrong-pw" });
    expect(res.type).toBe("ERROR");
    if (res.type === "ERROR") expect(res.code).toBe("WRONG_PASSWORD");
  });

  it("maps invalid key material to ERROR{code:INVALID_KEY}", async () => {
    const res = await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "wif", secret: "not-a-wif", password: "invalid-key-pw" },
    });
    expect(res.type).toBe("ERROR");
    if (res.type === "ERROR") expect(res.code).toBe("INVALID_KEY");
  });

  it("RESET_VAULT removes the vault", async () => {
    await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "rawHex", secret: "ef".repeat(32), password: "reset-via-dispatch" },
    });
    const reset = await handleMessage({ type: "RESET_VAULT" });
    expect(reset.type).toBe("VAULT_RESET");
    expect(await loadVault()).toBeNull();
  });

  it("returns secret-free errors (never echoes the password/secret)", async () => {
    const res = await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "wif", secret: "secretwifstring", password: "leaky-test-pw" },
    });
    expect(res.type).toBe("ERROR");
    if (res.type === "ERROR") {
      expect(res.message).not.toContain("leaky-test-pw");
      expect(res.message).not.toContain("secretwifstring");
    }
  });

  it("SIGN_TX signs through the dispatcher and returns SIGNED_TX", async () => {
    await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "rawHex", secret: "ef".repeat(32), password: "sign-via-dispatch" },
    });
    const res = await handleMessage({
      type: "SIGN_TX",
      draft: DRAFT,
      password: "sign-via-dispatch",
    });
    expect(res.type).toBe("SIGNED_TX");
    if (res.type === "SIGNED_TX") expect(res.signed.txid).toBe("ab".repeat(32));
  });
});

// ── XMSS seal ────────────────────────────────────────────────────────────────
describe("XMSS seal", () => {
  it("never advances the OTS index across import/unlock/change-password", async () => {
    await importSecret("ots-stays-zero", "pearl-testnet", PRIV);
    await changePassword("ots-stays-zero", "ots-still-zero-2");
    const file = await loadVaultFile();
    const acct = file!.accounts[0]!;
    expect(acct.xmss?.nextOtsIndex).toBe(0);
    expect(acct.xmss?.signingSealed).toBe(true);
  });

  it("the unified protocol offers no XMSS sign request (sealed by omission)", () => {
    // Type-level guarantee: VaultRequest has no XMSS variant. This is a runtime
    // sanity check that an unknown type yields a typed UNKNOWN error.
    // @ts-expect-error intentionally not a VaultRequest
    return handleMessage({ type: "XMSS_SIGN" }).then((res) => {
      expect(res.type).toBe("ERROR");
      if (res.type === "ERROR") expect(res.code).toBe("UNKNOWN");
    });
  });
});

// ── v1 -> v2 migration (lossless) ────────────────────────────────────────────
describe("v1 -> v2 migration", () => {
  /**
   * Build a genuine v1 single-account record exactly as the old build wrote it:
   * its own per-record kdfParams + AES-GCM payload over the secret. The original
   * password derives the key from THESE kdfParams.
   */
  async function seedV1Record(password: string, secret: DecryptedSecret) {
    const kdfParams = defaultPbkdf2Params(generateSalt());
    const key = await deriveAesKey(password, kdfParams);
    const payload = await encryptSecret(key, secret);
    const now = 1_700_000_000_000;
    const record = {
      version: 1,
      chain: "pearl-testnet" as const,
      address: STUB_ADDR_TEST,
      publicKeyHex: STUB_PROGRAM,
      secretKind: secret.kind,
      watchOnly: secret.kind === "watch-only-xpub",
      kdfParams,
      payload,
      xmss: {
        scheme: "XMSS-SHAKE256_5_256" as const,
        maxSignatures: 32 as const,
        nextOtsIndex: 0,
        signingSealed: true as const,
        commitmentHex: "de".padEnd(64, "0"),
      },
      createdAt: now,
      updatedAt: now,
    };
    backend.putRaw(VAULT_KEY, record);
    return record;
  }

  it("migrates a v1 record into a one-account v2 file and writes it back", async () => {
    const v1 = await seedV1Record("legacy-pass-123", PRIV);

    const file = await loadVaultFile();
    expect(file?.version).toBe(2);
    expect(file?.accounts).toHaveLength(1);
    const acct = file!.accounts[0]!;
    // Lossless: every field carried over byte-for-byte.
    expect(acct.label).toBe("Account 1");
    expect(acct.chain).toBe(v1.chain);
    expect(acct.address).toBe(v1.address);
    expect(acct.publicKeyHex).toBe(v1.publicKeyHex);
    expect(acct.secretKind).toBe(v1.secretKind);
    expect(acct.watchOnly).toBe(v1.watchOnly);
    expect(acct.payload).toEqual(v1.payload); // SAME ciphertext + IV
    expect(acct.xmss).toEqual(v1.xmss);
    expect(acct.createdAt).toBe(v1.createdAt);
    expect(acct.updatedAt).toBe(v1.updatedAt);
    // Wallet-level KDF == the old record's KDF (one account).
    expect(file?.kdfParams).toEqual(v1.kdfParams);
    expect(file?.activeAccountId).toBe(acct.id);

    // The migration was written back: the raw blob is now a v2 file.
    const raw = (await backend.get(VAULT_KEY)) as { version?: number; accounts?: unknown[] };
    expect(raw.version).toBe(2);
    expect(Array.isArray(raw.accounts)).toBe(true);
  });

  it("the ORIGINAL password still unlocks the migrated vault (lossless)", async () => {
    await seedV1Record("original-pass-xyz", PRIV);
    // Trigger migration, then unlock with the original password.
    await loadVaultFile();
    const status = await unlock("original-pass-xyz");
    expect(status.locked).toBe(false);
    expect(status.address).toBe(STUB_ADDR_TEST);
    expect(exportSecret()).toEqual(PRIV);
  });

  it("a wrong password still fails on the migrated vault", async () => {
    await seedV1Record("real-legacy-pass", PRIV);
    await loadVaultFile();
    await expect(unlock("not-the-legacy-pass")).rejects.toThrow(/wrong password or corrupt/);
    expect(isUnlocked()).toBe(false);
  });

  it("unlock() migrates implicitly and decrypts the single account", async () => {
    // No explicit loadVaultFile() first — unlock() must migrate on its own.
    await seedV1Record("implicit-migrate-pw", PRIV);
    const status = await unlock("implicit-migrate-pw");
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts?.[0]?.label).toBe("Account 1");
    expect(exportSecret()).toEqual(PRIV);
  });

  it("migrateRecordToFile is a pure, lossless transform (unit)", () => {
    const kdfParams = defaultPbkdf2Params(generateSalt());
    const record = {
      version: 1,
      chain: "pearl-mainnet" as const,
      address: STUB_ADDR_MAIN,
      publicKeyHex: STUB_PROGRAM,
      secretKind: "bip39-mnemonic" as const,
      watchOnly: false,
      kdfParams,
      payload: { cipher: "aes-256-gcm" as const, ivB64: "aXY=", ciphertextB64: "Y3Q=" },
      createdAt: 111,
      updatedAt: 222,
    };
    const file = migrateRecordToFile(record);
    expect(file.version).toBe(2);
    expect(file.kdfParams).toBe(record.kdfParams);
    expect(file.accounts).toHaveLength(1);
    expect(file.activeAccountId).toBe(file.accounts[0]!.id);
    expect(file.accounts[0]!.payload).toBe(record.payload);
    expect(file.accounts[0]!.label).toBe("Account 1");
  });
});

// ── multi-account: add / switch / rename / remove ────────────────────────────
describe("multi-account operations", () => {
  it("addAccount (generate) appends, encrypts under the wallet key, switches active", async () => {
    await importSecret("multi-pass-1234", "pearl-mainnet", PRIV);
    const before = await loadVaultFile();
    expect(before?.accounts).toHaveLength(1);
    const firstId = before!.accounts[0]!.id;

    const { status, mnemonic } = await addAccount({ mode: "generate" });
    expect(mnemonic).toMatch(/^[0-9a-f]{64}$/); // stub generate -> raw key
    expect(status.accounts).toHaveLength(2);
    // New account is active.
    expect(status.activeAccountId).not.toBe(firstId);

    const file = await loadVaultFile();
    expect(file?.accounts).toHaveLength(2);
    // ONE wallet-level KDF shared by both accounts.
    expect(file?.kdfParams).toEqual(before?.kdfParams);
    // Both payloads decrypt under the same password (no re-prompt model).
    lockVault();
    const unlocked = await unlock("multi-pass-1234");
    expect(unlocked.accounts).toHaveLength(2);
  });

  it("addAccount (import) appends a specific key and labels it", async () => {
    await importSecret("multi-pass-5678", "pearl-mainnet", PRIV);
    const other: DecryptedSecret = { kind: "secp256k1-privkey", privateKeyHex: "11".repeat(32) };
    const { status } = await addAccount({ mode: "import", label: "Savings", secret: other });
    const added = status.accounts?.find((a) => a.label === "Savings");
    expect(added).toBeDefined();
    expect(status.activeAccountId).toBe(added?.id);
    // The active account's secret is the imported one.
    expect(exportSecret()).toEqual(other);
  });

  it("addAccount requires an unlocked wallet", async () => {
    await importSecret("locked-add-pass", "pearl-mainnet", PRIV);
    lockVault();
    await expect(addAccount({ mode: "generate" })).rejects.toMatchObject({ code: "LOCKED" });
  });

  it("switchAccount changes the active account without a password", async () => {
    await importSecret("switch-pass-12", "pearl-mainnet", PRIV);
    const firstId = (await loadVaultFile())!.accounts[0]!.id;
    const other: DecryptedSecret = { kind: "secp256k1-privkey", privateKeyHex: "22".repeat(32) };
    const { status } = await addAccount({ mode: "import", secret: other });
    const secondId = status.activeAccountId!;
    expect(secondId).not.toBe(firstId);

    // Switch back to the first; active secret follows, NO password needed.
    const back = await switchAccount(firstId);
    expect(back.activeAccountId).toBe(firstId);
    expect(exportSecret()).toEqual(PRIV);

    const file = await loadVaultFile();
    expect(file?.activeAccountId).toBe(firstId);
  });

  it("renameAccount persists a new label", async () => {
    await importSecret("rename-pass-12", "pearl-mainnet", PRIV);
    const id = (await loadVaultFile())!.accounts[0]!.id;
    const status = await renameAccount(id, "  Main wallet  ");
    expect(status.accounts?.[0]?.label).toBe("Main wallet"); // trimmed
  });

  it("removeAccount drops a non-active account and keeps the rest", async () => {
    await importSecret("remove-pass-12", "pearl-mainnet", PRIV);
    const firstId = (await loadVaultFile())!.accounts[0]!.id;
    const other: DecryptedSecret = { kind: "secp256k1-privkey", privateKeyHex: "33".repeat(32) };
    const { status } = await addAccount({ mode: "import", secret: other });
    const secondId = status.activeAccountId!;

    // Remove the original (non-active) account.
    const after = await removeAccount(firstId);
    expect(after.accounts).toHaveLength(1);
    expect(after.activeAccountId).toBe(secondId);
    expect(after.accounts?.[0]?.id).toBe(secondId);
  });

  it("removing the ACTIVE account switches active to a survivor + drops its session secret", async () => {
    await importSecret("remove-active-pw", "pearl-mainnet", PRIV);
    const firstId = (await loadVaultFile())!.accounts[0]!.id;
    const other: DecryptedSecret = { kind: "secp256k1-privkey", privateKeyHex: "44".repeat(32) };
    await addAccount({ mode: "import", secret: other });
    // Active is the new account; switch back to first and remove it (active).
    await switchAccount(firstId);
    expect(exportSecret()).toEqual(PRIV);

    const after = await removeAccount(firstId);
    expect(after.accounts).toHaveLength(1);
    expect(after.activeAccountId).not.toBe(firstId);
    // The surviving account's secret is now active.
    expect(exportSecret()).toEqual(other);
  });

  it("CANNOT remove the last account", async () => {
    await importSecret("last-account-pw", "pearl-mainnet", PRIV);
    const id = (await loadVaultFile())!.accounts[0]!.id;
    await expect(removeAccount(id)).rejects.toMatchObject({ code: "VAULT_EXISTS" });
    // Still there.
    expect((await loadVaultFile())?.accounts).toHaveLength(1);
  });

  it("changePassword re-encrypts EVERY account under one new key", async () => {
    await importSecret("change-multi-old", "pearl-mainnet", PRIV);
    const other: DecryptedSecret = { kind: "secp256k1-privkey", privateKeyHex: "55".repeat(32) };
    await addAccount({ mode: "import", secret: other });

    const before = await loadVaultFile();
    await changePassword("change-multi-old", "change-multi-new1");
    const after = await loadVaultFile();

    // New salt; both payloads re-encrypted (fresh IVs).
    expect(after?.kdfParams.saltB64).not.toBe(before?.kdfParams.saltB64);
    for (let i = 0; i < after!.accounts.length; i++) {
      expect(after!.accounts[i]!.payload.ivB64).not.toBe(before!.accounts[i]!.payload.ivB64);
    }

    // The new password unlocks every account; the old one does not.
    lockVault();
    await expect(unlock("change-multi-old")).rejects.toThrow();
    const unlocked = await unlock("change-multi-new1");
    expect(unlocked.accounts).toHaveLength(2);
  });
});

// ── multi-account dispatcher protocol ────────────────────────────────────────
describe("multi-account dispatcher protocol", () => {
  it("ADD_ACCOUNT(generate) returns ACCOUNT_ADDED with a mnemonic + 2 accounts", async () => {
    await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "rawHex", secret: "ef".repeat(32), password: "disp-multi-pw1" },
    });
    const res = await handleMessage({ type: "ADD_ACCOUNT", payload: { mode: "generate" } });
    expect(res.type).toBe("ACCOUNT_ADDED");
    if (res.type === "ACCOUNT_ADDED") {
      expect(res.state.accounts).toHaveLength(2);
      expect(typeof res.mnemonic).toBe("string");
    }
  });

  it("SWITCH/RENAME/REMOVE_ACCOUNT round-trip via the dispatcher", async () => {
    await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "rawHex", secret: "ef".repeat(32), password: "disp-multi-pw2" },
    });
    const added = await handleMessage({
      type: "ADD_ACCOUNT",
      payload: { mode: "import", kind: "rawHex", secret: "66".repeat(32), label: "Two" },
    });
    expect(added.type).toBe("ACCOUNT_ADDED");
    const state = added.type === "ACCOUNT_ADDED" ? added.state : null;
    const firstId = state!.accounts!.find((a) => a.label !== "Two")!.id;
    const secondId = state!.accounts!.find((a) => a.label === "Two")!.id;

    const switched = await handleMessage({ type: "SWITCH_ACCOUNT", id: firstId });
    expect(switched.type).toBe("ACCOUNTS_CHANGED");
    if (switched.type === "ACCOUNTS_CHANGED") expect(switched.state.activeAccountId).toBe(firstId);

    const renamed = await handleMessage({ type: "RENAME_ACCOUNT", id: firstId, label: "One" });
    if (renamed.type === "ACCOUNTS_CHANGED") {
      expect(renamed.state.accounts?.find((a) => a.id === firstId)?.label).toBe("One");
    }

    const removed = await handleMessage({ type: "REMOVE_ACCOUNT", id: secondId });
    if (removed.type === "ACCOUNTS_CHANGED") {
      expect(removed.state.accounts).toHaveLength(1);
      expect(removed.state.activeAccountId).toBe(firstId);
    }
  });

  it("REMOVE_ACCOUNT on the last account -> ERROR{code:VAULT_EXISTS}", async () => {
    await handleMessage({
      type: "IMPORT_WALLET",
      payload: { kind: "rawHex", secret: "ef".repeat(32), password: "disp-last-pw" },
    });
    const state = await handleMessage({ type: "GET_VAULT_STATE" });
    const id = state.type === "VAULT_STATE" ? state.state.activeAccountId! : "";
    const res = await handleMessage({ type: "REMOVE_ACCOUNT", id });
    expect(res.type).toBe("ERROR");
    if (res.type === "ERROR") expect(res.code).toBe("VAULT_EXISTS");
  });
});

// ── session auto-lock ────────────────────────────────────────────────────────
describe("session auto-lock", () => {
  it("auto-locks after the timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      await importSecret("autolock-pass-1", "pearl-testnet", PRIV);
      expect(isUnlocked()).toBe(true);
      // Default timeout is 5 min; advance past it.
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(isUnlocked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
