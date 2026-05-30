/**
 * Key derivation for the vault.
 *
 * The vault's at-rest secret is encrypted with AES-256-GCM under a key derived
 * from the user's passphrase. The default KDF is WebCrypto PBKDF2-HMAC-SHA256,
 * which is always available in an MV3 service worker (no extra bundle, no remote
 * code, no native dependency) and satisfies the "no hand-rolled crypto"
 * constraint because the primitive comes from the platform.
 *
 * ── Argon2id seam ────────────────────────────────────────────────────────────
 * PBKDF2 is intentionally pluggable. Argon2id is the preferred memory-hard KDF
 * and is reachable WITHOUT remote code via the bundled, audited
 * `@noble/hashes/argon2` (`argon2idAsync`). It is left OFF by default and gated
 * behind `deriveAesKey`'s `kdf` switch for these MV3-specific reasons:
 *   - Argon2id wants tens of MiB of scratch memory; an MV3 service worker can be
 *     killed/evicted aggressively, so the memory cost must be tuned modestly
 *     (e.g. m=19456 KiB / t=2 / p=1, per OWASP) to stay responsive on unlock.
 *   - WebAssembly is NOT permitted under the strict extension CSP, so any
 *     Argon2 implementation must be pure-JS (`@noble/hashes/argon2` is). It is
 *     slower than a wasm build but auditable and CSP-clean.
 * To enable it, the import flow records `kdf: "argon2id"` with cost params in the
 * VaultRecord; `deriveAesKey` then routes to `deriveArgon2idKey`. The Argon2id
 * code path is dynamically imported so PBKDF2-only vaults never pull it in.
 */

import type { KdfParams } from "./vault-types.js";

/** OWASP-aligned default for PBKDF2-HMAC-SHA256 (2023+). High by design. */
export const PBKDF2_DEFAULT_ITERATIONS = 600_000;

/** Salt length in bytes. 16 bytes (128 bits) is standard and ample. */
export const SALT_BYTES = 16;

/** Conservative, MV3-tuned Argon2id defaults (OWASP profile). */
export const ARGON2ID_DEFAULT_TIME_COST = 2;
export const ARGON2ID_DEFAULT_MEMORY_KIB = 19_456; // 19 MiB
export const ARGON2ID_DEFAULT_PARALLELISM = 1;

/** Derived AES key length in bits. */
const AES_KEY_BITS = 256;

const textEncoder = new TextEncoder();

/** Generate a fresh random KDF salt. */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/** Build default KDF params for a brand-new vault using PBKDF2 (the MV3 default). */
export function defaultPbkdf2Params(salt: Uint8Array): KdfParams {
  return {
    kdf: "pbkdf2-sha256",
    saltB64: bytesToBase64(salt),
    iterations: PBKDF2_DEFAULT_ITERATIONS,
  };
}

/**
 * Derive a non-extractable AES-256-GCM `CryptoKey` from a passphrase + KDF
 * params. The returned key is `extractable: false`, so even with a reference to
 * it the raw bytes cannot be read back out — it can only be used to
 * encrypt/decrypt.
 */
export async function deriveAesKey(
  passphrase: string,
  params: KdfParams,
): Promise<CryptoKey> {
  const salt = base64ToBytes(params.saltB64);
  switch (params.kdf) {
    case "pbkdf2-sha256":
      return derivePbkdf2Key(passphrase, salt, params.iterations ?? PBKDF2_DEFAULT_ITERATIONS);
    case "argon2id":
      return deriveArgon2idKey(passphrase, salt, params);
    default: {
      // Exhaustiveness guard: unknown KDF must fail loudly, never silently.
      const _never: never = params.kdf;
      throw new Error(`unsupported kdf: ${String(_never)}`);
    }
  }
}

/** PBKDF2-HMAC-SHA256 → AES-256-GCM key via WebCrypto. */
async function derivePbkdf2Key(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("pbkdf2 iterations must be a positive integer");
  }
  const baseKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    /* extractable */ false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: AES_KEY_BITS },
    /* extractable */ false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Argon2id hook signature. Implementations MUST be pure-JS and CSP-clean (no
 * wasm, no remote code). The intended implementation is the bundled, audited
 * `@noble/hashes/argon2`'s `argon2idAsync`, registered by the layer that already
 * depends on `@noble/hashes` (e.g. wallet-core or the worker bootstrap) via
 * `setArgon2idFn`. The vault package itself does NOT hard-import `@noble/hashes`
 * so PBKDF2-only builds carry no transitive crypto dependency.
 */
export type Argon2idFn = (
  password: Uint8Array,
  salt: Uint8Array,
  opts: { t: number; m: number; p: number; dkLen: number },
) => Promise<Uint8Array>;

let argon2idFn: Argon2idFn | null = null;

/** Register the Argon2id implementation (enables the `argon2id` KDF). */
export function setArgon2idFn(fn: Argon2idFn): void {
  argon2idFn = fn;
}

/**
 * Argon2id → AES-256-GCM key. Produces 32 raw bytes via the registered
 * `Argon2idFn` and imports them as a non-extractable AES-GCM key. Throws a clear
 * error if no implementation has been registered (PBKDF2 remains the default).
 */
async function deriveArgon2idKey(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<CryptoKey> {
  if (!argon2idFn) {
    throw new Error(
      "argon2id KDF requested but no implementation registered; call setArgon2idFn() or use pbkdf2-sha256",
    );
  }
  const raw = await argon2idFn(textEncoder.encode(passphrase), salt, {
    t: params.timeCost ?? ARGON2ID_DEFAULT_TIME_COST,
    m: params.memoryCostKiB ?? ARGON2ID_DEFAULT_MEMORY_KIB,
    p: params.parallelism ?? ARGON2ID_DEFAULT_PARALLELISM,
    dkLen: AES_KEY_BITS / 8,
  });
  try {
    return await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(raw),
      { name: "AES-GCM", length: AES_KEY_BITS },
      /* extractable */ false,
      ["encrypt", "decrypt"],
    );
  } finally {
    // Best-effort wipe of the raw derived bytes once imported.
    raw.fill(0);
  }
}

// ── base64 / byte helpers (no Buffer; works in SW + node test env) ────────────

/** Encode bytes as standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

/** Decode standard base64 to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Return a tightly-sized ArrayBuffer view of `bytes`. WebCrypto wants a
 * BufferSource; passing the underlying buffer directly can leak adjacent bytes
 * when the Uint8Array is a subarray, so copy when not aligned.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
