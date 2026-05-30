/**
 * Runtime validation schemas (zod) for boundary data: messages crossing the
 * extension's port boundary and payloads exchanged with the backend API.
 *
 * Grain amounts are validated as bigints (or numeric strings coerced to bigint)
 * so that nothing on the money path ever round-trips through a float.
 */

import { z } from "zod";
import { MAX_GRAIN } from "./amounts.js";

export const networkSchema = z.enum([
  "mainnet",
  "testnet",
  "testnet2",
  "regtest",
  "simnet",
  "signet",
]);

/** A non-negative Grain amount, accepted as bigint or decimal-integer string. */
export const grainSchema = z
  .union([z.bigint(), z.string().regex(/^\d+$/, "grain must be a whole number")])
  .transform((v) => (typeof v === "bigint" ? v : BigInt(v)))
  .refine((v) => v >= 0n, "grain must be non-negative")
  .refine((v) => v <= MAX_GRAIN, "grain exceeds supply cap");

/** Lowercase hex string of arbitrary even length. */
export const hexSchema = z
  .string()
  .regex(/^[0-9a-f]*$/i, "must be hex")
  .refine((s) => s.length % 2 === 0, "hex must have even length");

/** A 32-byte big-endian txid in display hex. */
export const txidSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, "txid must be 64 hex chars");

/** A bech32m address. HRP/charset are validated by wallet-core; this is a shape gate. */
export const addressSchema = z
  .string()
  .min(8)
  .regex(/^[a-z]{2,4}1[02-9ac-hj-np-z]+$/, "must look like a bech32m address");

export const utxoSchema = z.object({
  txid: txidSchema,
  vout: z.number().int().nonnegative(),
  value: grainSchema,
  scriptPubKeyHex: hexSchema,
  address: addressSchema.optional(),
  confirmations: z.number().int().nonnegative().optional(),
});

export const txRecipientSchema = z.object({
  address: addressSchema,
  value: grainSchema,
});

export const necklaceFeeSchema = z.object({
  address: addressSchema,
  value: grainSchema,
});

export const txDraftSchema = z.object({
  network: networkSchema,
  inputs: z.array(utxoSchema).min(1),
  recipients: z.array(txRecipientSchema).min(1),
  change: txRecipientSchema.optional(),
  necklaceFee: necklaceFeeSchema.optional(),
  minerFee: grainSchema,
});

export const signedTxSchema = z.object({
  txid: txidSchema,
  rawHex: hexSchema,
});

export const encryptedVaultSchema = z.object({
  version: z.number().int().positive(),
  kdf: z.string(),
  kdfIterations: z.number().int().positive(),
  saltB64: z.string(),
  ivB64: z.string(),
  cipher: z.string(),
  ciphertextB64: z.string(),
});

// --- API request/response payloads ---

/** GET /utxos?address=... response. */
export const utxosResponseSchema = z.object({
  network: networkSchema,
  address: addressSchema,
  utxos: z.array(utxoSchema),
});

/** POST /broadcast request: the only thing the client ever sends for sending. */
export const broadcastRequestSchema = z.object({
  network: networkSchema,
  rawHex: hexSchema,
});

/** POST /broadcast response. */
export const broadcastResponseSchema = z.object({
  txid: txidSchema,
  accepted: z.boolean(),
});

/** GET /health response. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  network: networkSchema.optional(),
  uptimeSeconds: z.number().nonnegative(),
});

export type NetworkInput = z.infer<typeof networkSchema>;
export type UtxoInput = z.infer<typeof utxoSchema>;
export type TxDraftInput = z.infer<typeof txDraftSchema>;
export type BroadcastRequest = z.infer<typeof broadcastRequestSchema>;
export type BroadcastResponse = z.infer<typeof broadcastResponseSchema>;
export type UtxosResponse = z.infer<typeof utxosResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
