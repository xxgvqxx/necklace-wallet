/**
 * Wire schemas for the read/broadcast API, validated with zod.
 *
 * The API is UNTRUSTED for confidentiality and integrity (threat-model §2): the
 * extension validates every response shape, treats all bytes as inert data
 * (never executed — CSP-enforced), and never lets API output determine fees or
 * signing inputs beyond the prevout values it cryptographically commits to in
 * the sighash.
 *
 * These schemas extend / specialise the shared boundary schemas where the
 * documented HTTP contract differs in detail from the
 * generic internal shapes in `@necklace/shared`. Grain amounts arrive as JSON
 * integers (the contract uses `int64` Grain on the wire); we coerce them to the
 * `Grain` bigint domain via {@link grainFromJson} so the money path never
 * touches a float.
 */

import { z } from "zod";
import { MAX_GRAIN, type Grain } from "@necklace/shared";

/** Networks the API may report. Matches `@necklace/shared` Network union. */
export const apiNetworkSchema = z.enum([
  "mainnet",
  "testnet",
  "testnet2",
  "regtest",
  "simnet",
  "signet",
]);

/**
 * A Grain amount as it appears on the API wire: a JSON integer (int64). We
 * accept JS numbers and numeric strings and convert to bigint Grain, rejecting
 * anything non-integral, negative, or above the supply cap. `unconfirmed` deltas
 * may be negative, so a dedicated signed variant is provided below.
 */
export const grainFromJson = z
  .union([z.number().int(), z.string().regex(/^-?\d+$/)])
  .transform((v): Grain => BigInt(v))
  .refine((v) => v >= 0n, "grain must be non-negative")
  .refine((v) => v <= MAX_GRAIN, "grain exceeds supply cap");

/** Signed Grain (used for `unconfirmed` / `netValue`, which can be negative). */
export const signedGrainFromJson = z
  .union([z.number().int(), z.string().regex(/^-?\d+$/)])
  .transform((v): Grain => BigInt(v))
  .refine((v) => v >= -MAX_GRAIN && v <= MAX_GRAIN, "grain out of range");

/** A 32-byte big-endian txid in display hex. */
export const txidSchema = z.string().regex(/^[0-9a-f]{64}$/i, "bad txid");

/** Lowercase/any-case hex, even length. */
export const hexSchema = z
  .string()
  .regex(/^[0-9a-fA-F]*$/, "must be hex")
  .refine((s) => s.length % 2 === 0, "hex must have even length");

/** Shape gate for an address; full bech32m validation is done in wallet-core. */
export const addressSchema = z.string().min(8).max(120);

// --- GET /health ---------------------------------------------------------

export const healthResponseSchema = z.object({
  status: z.string(),
  network: apiNetworkSchema,
  nodeVersion: z.string().optional(),
  synced: z.boolean().optional(),
  tipHeight: z.number().int().nonnegative().optional(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// --- GET /tip ------------------------------------------------------------

export const tipResponseSchema = z.object({
  height: z.number().int().nonnegative(),
  hash: z.string(),
  time: z.number().int().nonnegative(),
});
export type TipResponse = z.infer<typeof tipResponseSchema>;

// --- GET /address/:address/balance --------------------------------------

export const balanceResponseSchema = z.object({
  address: addressSchema,
  confirmed: grainFromJson,
  unconfirmed: signedGrainFromJson,
  total: signedGrainFromJson,
});
export type BalanceResponse = z.infer<typeof balanceResponseSchema>;

// --- GET /address/:address/utxos ----------------------------------------

export const apiUtxoSchema = z.object({
  txid: txidSchema,
  vout: z.number().int().nonnegative(),
  value: grainFromJson,
  pkScript: hexSchema,
  confirmations: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().nullable().optional(),
});
export type ApiUtxo = z.infer<typeof apiUtxoSchema>;

export const utxosResponseSchema = z.object({
  address: addressSchema,
  utxos: z.array(apiUtxoSchema),
  cursor: z.string().nullable().optional(),
});
export type UtxosResponse = z.infer<typeof utxosResponseSchema>;

// --- GET /address/:address/txs ------------------------------------------

export const txDirectionSchema = z.enum(["sent", "received", "self"]);

export const activityTxSchema = z.object({
  txid: txidSchema,
  height: z.number().int().nonnegative().nullable().optional(),
  confirmations: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  netValue: signedGrainFromJson,
  fee: grainFromJson.optional(),
  direction: txDirectionSchema,
});
export type ActivityTx = z.infer<typeof activityTxSchema>;

export const txsResponseSchema = z.object({
  address: addressSchema,
  txs: z.array(activityTxSchema),
  cursor: z.string().nullable().optional(),
});
export type TxsResponse = z.infer<typeof txsResponseSchema>;

// --- transaction detail (GET tx by id) ----------------------------------

/** One side of a transaction (an input "from" or an output "to"). */
export interface TxIo {
  /** Address, if decodable. Absent for coinbase / non-address scripts. */
  address?: string;
  /** Value in Grain. */
  value: Grain;
}

/** Full transaction detail for the activity drill-down view. */
export interface TxDetail {
  txid: string;
  confirmations: number;
  /** Block time (unix seconds); 0 if unconfirmed. */
  time: number;
  height?: number | null;
  /** Network/miner fee in Grain, if reported. */
  fee?: Grain;
  /** Senders. */
  inputs: TxIo[];
  /** Receivers. */
  outputs: TxIo[];
  /** Total of all outputs (the whole amount moved), in Grain. */
  valueOut: Grain;
}

// --- GET /fees/recommended ----------------------------------------------

export const feesResponseSchema = z.object({
  feePerKb: grainFromJson,
  tiers: z
    .object({
      fast: grainFromJson,
      normal: grainFromJson,
      slow: grainFromJson,
    })
    .partial()
    .optional(),
  minRelayFeePerKb: grainFromJson.optional(),
});
export type FeesResponse = z.infer<typeof feesResponseSchema>;

// --- POST /tx/broadcast --------------------------------------------------

export const broadcastResponseSchema = z.object({
  txid: txidSchema,
  accepted: z.boolean(),
  alreadyKnown: z.boolean().optional(),
});
export type BroadcastResponse = z.infer<typeof broadcastResponseSchema>;

// --- Standard error envelope --------------------------------------------

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
    /** Some deployments attach `txid` for the 409 ALREADY_KNOWN encoding. */
    txid: txidSchema.optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
