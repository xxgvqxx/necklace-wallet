/**
 * Persistence for the encrypted vault.
 *
 * Hard rules:
 *  - Key material lives ONLY in `chrome.storage.local` (device-local), NEVER in
 *    `chrome.storage.sync`. Syncing an encrypted vault across devices would let
 *    a passphrase compromise on any one device reach all of them, and — for the
 *    XMSS OTS counter — would enable catastrophic index rollback. We therefore
 *    never touch `storage.sync` here.
 *  - On the service worker we call
 *    `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`
 *    so the store is unreachable from untrusted/injected page contexts.
 *  - Only the encrypted `VaultRecord` is persisted. The decrypted secret and the
 *    derived key never go to storage (see `session.ts`).
 *
 * A thin `StorageBackend` seam lets tests inject an in-memory store; in
 * production it binds to `chrome.storage.local`.
 */

import {
  VAULT_FILE_VERSION,
  type VaultAccount,
  type VaultFile,
  type VaultRecord,
} from "./vault-types.js";
import { CorruptVaultError } from "./errors.js";

/**
 * Storage key under which the encrypted vault lives. The key is unchanged from
 * v1 (a v1 record and a v2 file occupy the same slot); the blob's shape is
 * disambiguated at load time and v1 is migrated in place to v2.
 */
export const VAULT_KEY = "necklace.vault.v1" as const;

/**
 * Minimal async key/value backend. Mirrors the shape of
 * `chrome.storage.local`'s promise API for the operations we use.
 */
export interface StorageBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Build a backend bound to `chrome.storage.local`. */
function chromeLocalBackend(): StorageBackend {
  return {
    async get(key) {
      const out = await chrome.storage.local.get(key);
      return out[key];
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage.local.remove(key);
    },
  };
}

let backend: StorageBackend | null = null;

/**
 * Override the storage backend (tests only). Passing `null` resets to the
 * chrome.storage.local backend.
 */
export function __setStorageBackend(b: StorageBackend | null): void {
  backend = b;
}

function getBackend(): StorageBackend {
  if (backend) return backend;
  backend = chromeLocalBackend();
  return backend;
}

let accessLevelEnsured = false;

/**
 * Restrict `chrome.storage.local` to trusted contexts. Idempotent and safe to
 * call on every worker startup. No-op (and silent) when `chrome.storage` is not
 * present (e.g. unit tests) or the API is unavailable on older Chrome.
 */
export async function ensureTrustedAccessLevel(): Promise<void> {
  if (accessLevelEnsured) return;
  try {
    if (
      typeof chrome !== "undefined" &&
      chrome.storage?.local?.setAccessLevel
    ) {
      await chrome.storage.local.setAccessLevel({
        accessLevel: "TRUSTED_CONTEXTS",
      });
    }
  } catch {
    // Older Chrome may not support setAccessLevel; the strict CSP + minimal
    // permissions still apply. Do not throw on startup.
  } finally {
    accessLevelEnsured = true;
  }
}

/**
 * Validate that an untrusted, persisted blob has the structural shape of a
 * `VaultRecord`. We check only the NON-secret framing fields needed to safely
 * attempt a decrypt (the ciphertext bytes themselves are authenticated by
 * AES-GCM on unlock). A structurally broken record is unrecoverable without the
 * recovery phrase, so we fail closed with a typed `CorruptVaultError` rather
 * than letting a malformed object flow into the KDF / cipher and produce a
 * confusing downstream failure.
 *
 * This never throws on a wrong-but-well-formed record (that surfaces later as a
 * GCM auth failure -> WRONG_PASSWORD); it only rejects records that cannot be a
 * vault at all.
 */
export function validateVaultRecord(raw: unknown): VaultRecord {
  const fail = (why: string): never => {
    throw new CorruptVaultError(`vault record is corrupt: ${why}`);
  };
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const r = raw as Record<string, unknown>;

  if (typeof r.version !== "number") return fail("missing version");
  if (r.chain !== "pearl-mainnet" && r.chain !== "pearl-testnet") {
    return fail("invalid chain");
  }
  if (typeof r.address !== "string" || r.address.length === 0) {
    return fail("missing address");
  }
  if (
    r.secretKind !== "secp256k1-privkey" &&
    r.secretKind !== "bip39-mnemonic" &&
    r.secretKind !== "watch-only-xpub"
  ) {
    return fail("invalid secretKind");
  }
  if (typeof r.watchOnly !== "boolean") return fail("missing watchOnly");

  const kdf = r.kdfParams as Record<string, unknown> | undefined;
  if (typeof kdf !== "object" || kdf === null) return fail("missing kdfParams");
  if (kdf.kdf !== "pbkdf2-sha256" && kdf.kdf !== "argon2id") {
    return fail("invalid kdf");
  }
  if (typeof kdf.saltB64 !== "string" || kdf.saltB64.length === 0) {
    return fail("missing kdf salt");
  }

  const payload = r.payload as Record<string, unknown> | undefined;
  if (typeof payload !== "object" || payload === null) return fail("missing payload");
  if (payload.cipher !== "aes-256-gcm") return fail("invalid cipher");
  if (typeof payload.ivB64 !== "string" || payload.ivB64.length === 0) {
    return fail("missing iv");
  }
  if (typeof payload.ciphertextB64 !== "string" || payload.ciphertextB64.length === 0) {
    return fail("missing ciphertext");
  }

  return raw as VaultRecord;
}

/**
 * Validate a single account inside a v2 file. Mirrors `validateVaultRecord`'s
 * framing checks, MINUS `kdfParams` (wallet-level now) PLUS `id` + `label`.
 * Fails closed with `CorruptVaultError` on any malformed-but-present account.
 */
function validateVaultAccount(raw: unknown, index: number): VaultAccount {
  const fail = (why: string): never => {
    throw new CorruptVaultError(`vault account[${index}] is corrupt: ${why}`);
  };
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const a = raw as Record<string, unknown>;

  if (typeof a.id !== "string" || a.id.length === 0) return fail("missing id");
  if (typeof a.label !== "string" || a.label.length === 0) return fail("missing label");
  if (a.chain !== "pearl-mainnet" && a.chain !== "pearl-testnet") {
    return fail("invalid chain");
  }
  if (typeof a.address !== "string" || a.address.length === 0) {
    return fail("missing address");
  }
  if (
    a.secretKind !== "secp256k1-privkey" &&
    a.secretKind !== "bip39-mnemonic" &&
    a.secretKind !== "watch-only-xpub"
  ) {
    return fail("invalid secretKind");
  }
  if (typeof a.watchOnly !== "boolean") return fail("missing watchOnly");

  const payload = a.payload as Record<string, unknown> | undefined;
  if (typeof payload !== "object" || payload === null) return fail("missing payload");
  if (payload.cipher !== "aes-256-gcm") return fail("invalid cipher");
  if (typeof payload.ivB64 !== "string" || payload.ivB64.length === 0) {
    return fail("missing iv");
  }
  if (typeof payload.ciphertextB64 !== "string" || payload.ciphertextB64.length === 0) {
    return fail("missing ciphertext");
  }

  return raw as VaultAccount;
}

/**
 * Validate that an untrusted, persisted blob has the structural shape of a v2
 * {@link VaultFile}. Analogous to {@link validateVaultRecord}: we check only the
 * NON-secret framing fields (the ciphertext bytes are authenticated by AES-GCM
 * on unlock) and fail closed with a typed `CorruptVaultError` on anything that
 * cannot be a vault file at all. Never throws on a wrong-but-well-formed file.
 */
export function validateVaultFile(raw: unknown): VaultFile {
  const fail = (why: string): never => {
    throw new CorruptVaultError(`vault file is corrupt: ${why}`);
  };
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const f = raw as Record<string, unknown>;

  if (f.version !== VAULT_FILE_VERSION) return fail("not a v2 file");
  if (!Array.isArray(f.accounts) || f.accounts.length === 0) {
    return fail("missing accounts");
  }

  const kdf = f.kdfParams as Record<string, unknown> | undefined;
  if (typeof kdf !== "object" || kdf === null) return fail("missing kdfParams");
  if (kdf.kdf !== "pbkdf2-sha256" && kdf.kdf !== "argon2id") {
    return fail("invalid kdf");
  }
  if (typeof kdf.saltB64 !== "string" || kdf.saltB64.length === 0) {
    return fail("missing kdf salt");
  }

  const accounts = f.accounts.map((a, i) => validateVaultAccount(a, i));

  if (typeof f.activeAccountId !== "string" || f.activeAccountId.length === 0) {
    return fail("missing activeAccountId");
  }
  if (!accounts.some((a) => a.id === f.activeAccountId)) {
    return fail("activeAccountId does not match any account");
  }

  return raw as VaultFile;
}

/**
 * Losslessly migrate a v1 single-account {@link VaultRecord} into a v2
 * {@link VaultFile} holding exactly one "Account 1".
 *
 * The original password MUST still unlock it: there was only one account, so the
 * wallet-level `kdfParams` are the v1 record's own `kdfParams`, and the account's
 * `payload` is the v1 `payload` byte-for-byte. No re-encryption, no re-derivation
 * — the same key derived from the original password decrypts the same ciphertext.
 */
export function migrateRecordToFile(record: VaultRecord): VaultFile {
  const id = randomId();
  const account: VaultAccount = {
    id,
    label: "Account 1",
    chain: record.chain,
    address: record.address,
    ...(record.publicKeyHex !== undefined ? { publicKeyHex: record.publicKeyHex } : {}),
    secretKind: record.secretKind,
    watchOnly: record.watchOnly,
    payload: record.payload,
    ...(record.xmss !== undefined ? { xmss: record.xmss } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return {
    version: VAULT_FILE_VERSION,
    activeAccountId: id,
    kdfParams: record.kdfParams,
    accounts: [account],
  };
}

/** Whether a persisted blob looks like a legacy v1 record (top-level payload, no accounts). */
function isV1Record(raw: Record<string, unknown>): boolean {
  return (
    !Array.isArray(raw.accounts) &&
    "kdfParams" in raw &&
    "payload" in raw &&
    typeof raw.payload === "object" &&
    raw.payload !== null
  );
}

/**
 * Read the persisted vault file, or null if none exists.
 *
 * Migration: if the stored blob is a v1 single-account record (top-level
 * `kdfParams` + `payload`, no `accounts` array) it is validated, converted to a
 * v2 file via {@link migrateRecordToFile}, and WRITTEN BACK before being
 * returned — so the very next load sees a v2 file and the original password
 * still unlocks it.
 *
 * @throws CorruptVaultError if a blob is present but structurally invalid.
 */
export async function loadVaultFile(): Promise<VaultFile | null> {
  const raw = await getBackend().get(VAULT_KEY);
  if (raw == null) return null;
  if (typeof raw === "object" && raw !== null && isV1Record(raw as Record<string, unknown>)) {
    const record = validateVaultRecord(raw);
    const file = migrateRecordToFile(record);
    await saveVaultFile(file);
    return file;
  }
  return validateVaultFile(raw);
}

/** Persist (create or replace) the entire vault file. */
export async function saveVaultFile(file: VaultFile): Promise<void> {
  await getBackend().set(VAULT_KEY, file);
}

/**
 * Read the persisted v1 vault record, or null if none exists.
 *
 * Retained for the v1->v2 migration and the structural validator. New code reads
 * {@link loadVaultFile}; this returns null when the stored blob is already a v2
 * file (so callers that still want a single "record" do not mis-parse a file).
 *
 * @throws CorruptVaultError if a record is present but structurally invalid.
 */
export async function loadVault(): Promise<VaultRecord | null> {
  const raw = await getBackend().get(VAULT_KEY);
  if (raw == null) return null;
  if (typeof raw === "object" && raw !== null && Array.isArray((raw as { accounts?: unknown }).accounts)) {
    // Already a v2 file — not a v1 record.
    return null;
  }
  return validateVaultRecord(raw);
}

/** Persist (create or replace) a v1 vault record. Retained for tests/migration. */
export async function saveVault(record: VaultRecord): Promise<void> {
  await getBackend().set(VAULT_KEY, record);
}

/** Delete the vault file entirely. */
export async function deleteVault(): Promise<void> {
  await getBackend().remove(VAULT_KEY);
}

/** Whether a vault currently exists (v1 record or v2 file). */
export async function hasVault(): Promise<boolean> {
  return (await getBackend().get(VAULT_KEY)) != null;
}

/** Generate a stable, opaque account id. */
export function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments without randomUUID (should not occur in MV3/node20).
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Atomically read-modify-write the vault FILE under a process-local mutex.
 *
 * MV3 service workers are single-threaded per worker, but message handlers
 * interleave at `await` points; this serializes vault mutations so two handlers
 * cannot read-then-clobber each other. The XMSS OTS-counter advance (if ever
 * enabled) MUST go through this so the counter can never be rolled back within
 * the store.
 *
 * `mutate` receives the current file (or null) and returns the next file, or
 * null to delete. It MUST be pure w.r.t. storage (do no other storage I/O). The
 * read goes through {@link loadVaultFile}, so a v1 record is migrated under the
 * lock before `mutate` runs.
 */
let mutationChain: Promise<unknown> = Promise.resolve();

export function updateVaultAtomic(
  mutate: (current: VaultFile | null) => VaultFile | null,
): Promise<VaultFile | null> {
  const run = async (): Promise<VaultFile | null> => {
    const current = await loadVaultFile();
    const next = mutate(current);
    if (next === null) {
      await deleteVault();
      return null;
    }
    await saveVaultFile(next);
    return next;
  };
  // Chain on the previous mutation, swallowing its result/rejection so one
  // failed mutation does not poison the queue.
  const result = mutationChain.then(run, run);
  mutationChain = result.catch(() => undefined);
  return result;
}
