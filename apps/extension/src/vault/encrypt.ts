/**
 * Authenticated encryption for the vault payload.
 *
 * AES-256-GCM via WebCrypto. Invariants:
 *  - A fresh, cryptographically random 96-bit IV is generated for EVERY
 *    encryption and stored alongside the ciphertext. IVs are NEVER reused with
 *    the same key (the GCM nonce-reuse catastrophe).
 *  - The 16-byte GCM auth tag is appended to the ciphertext by WebCrypto, so a
 *    wrong passphrase (wrong derived key) or any tampering fails decryption with
 *    an exception rather than yielding garbage plaintext.
 *  - Plaintext is the JSON serialization of the `DecryptedSecret`. Plaintext
 *    bytes are zeroed after encryption / after decryption hand-off where we
 *    control the buffer.
 *
 * The derived `CryptoKey` is non-extractable (see `kdf.ts`); this module never
 * sees raw key bytes and never logs plaintext.
 */

import type {
  CipherId,
  DecryptedSecret,
  EncryptedPayload,
} from "./vault-types.js";
import { base64ToBytes, bytesToBase64 } from "./kdf.js";

/** GCM IV length in bytes (96 bits — the recommended size). */
export const GCM_IV_BYTES = 12;

const CIPHER: CipherId = "aes-256-gcm";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encrypt a `DecryptedSecret` under the derived AES key.
 * Generates a fresh random IV; returns the IV + ciphertext as base64.
 */
export async function encryptSecret(
  key: CryptoKey,
  secret: DecryptedSecret,
): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const plaintext = textEncoder.encode(JSON.stringify(secret));
  try {
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toBuffer(iv) },
      key,
      toBuffer(plaintext),
    );
    return {
      cipher: CIPHER,
      ivB64: bytesToBase64(iv),
      ciphertextB64: bytesToBase64(new Uint8Array(ct)),
    };
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Decrypt an `EncryptedPayload` back into a `DecryptedSecret`. Throws if the
 * passphrase/key is wrong or the ciphertext was tampered with (GCM tag fails).
 */
export async function decryptSecret(
  key: CryptoKey,
  payload: EncryptedPayload,
): Promise<DecryptedSecret> {
  if (payload.cipher !== CIPHER) {
    throw new Error(`unsupported cipher: ${payload.cipher}`);
  }
  const iv = base64ToBytes(payload.ivB64);
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error("invalid IV length");
  }
  const ct = base64ToBytes(payload.ciphertextB64);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toBuffer(iv) },
      key,
      toBuffer(ct),
    );
  } catch {
    // Normalize to a single opaque error; never leak which step failed and
    // never include any payload bytes in the message.
    throw new Error("decryption failed: wrong password or corrupt vault");
  }
  const bytes = new Uint8Array(plaintext);
  try {
    const json = textDecoder.decode(bytes);
    const parsed = JSON.parse(json) as unknown;
    return assertDecryptedSecret(parsed);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Coerce a byte view to a tightly-sized `ArrayBuffer` for WebCrypto, which
 * rejects `SharedArrayBuffer`-backed views in strict typings. Copies when the
 * view is a subarray so adjacent bytes never leak into the operation.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/** Narrow untrusted parsed JSON to a `DecryptedSecret`, or throw. */
function assertDecryptedSecret(value: unknown): DecryptedSecret {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new Error("malformed decrypted secret");
  }
  const v = value as { kind?: unknown };
  switch (v.kind) {
    case "secp256k1-privkey": {
      const s = value as { privateKeyHex?: unknown };
      if (typeof s.privateKeyHex !== "string" || !/^[0-9a-f]{64}$/.test(s.privateKeyHex)) {
        throw new Error("malformed secp256k1 secret");
      }
      return { kind: "secp256k1-privkey", privateKeyHex: s.privateKeyHex };
    }
    case "bip39-mnemonic": {
      const s = value as { mnemonic?: unknown; passphrase?: unknown };
      if (typeof s.mnemonic !== "string" || s.mnemonic.length === 0) {
        throw new Error("malformed mnemonic secret");
      }
      return {
        kind: "bip39-mnemonic",
        mnemonic: s.mnemonic,
        ...(typeof s.passphrase === "string" ? { passphrase: s.passphrase } : {}),
      };
    }
    case "watch-only-xpub": {
      const s = value as { xpub?: unknown };
      if (typeof s.xpub !== "string" || s.xpub.length === 0) {
        throw new Error("malformed watch-only secret");
      }
      return { kind: "watch-only-xpub", xpub: s.xpub };
    }
    default:
      throw new Error("unknown decrypted secret kind");
  }
}
