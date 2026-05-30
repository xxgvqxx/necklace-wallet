/**
 * Local recipient-address and amount validation (Phase 1 format rules).
 *
 * "Address validation is client-side first" (api-contract §8): the extension
 * validates bech32m + witness version + HRP locally before any API call, so a
 * swapped or wrong-network destination is caught before a single byte is sent.
 *
 * Phase 1 facts enforced here (docs/protocol-findings.md, derived-address.json):
 *   - bech32m (BIP-350) only; legacy bech32 v0 is REJECTED.
 *   - HRP must match the active network: prl / tprl / rprl.
 *   - witness program is always 32 bytes.
 *   - MVP signs P2TR (witness v1) only; v2 (P2MR) is recognised but out of scope
 *     for SENDING (we refuse to build a tx that pays a v2 output in the MVP).
 */

import {
  DUST_THRESHOLD_GRAIN,
  HRP_BY_NETWORK,
  MAX_GRAIN,
  prlToGrain,
  AmountError,
  type Grain,
  type Network,
} from "@necklace/shared";
import { decodeSegwitAddress } from "./bech32m.js";

export type AddressValidationError =
  | "EMPTY"
  | "MALFORMED"
  | "WRONG_NETWORK"
  | "UNSUPPORTED_WITNESS_VERSION"
  | "BAD_PROGRAM_LENGTH";

export interface AddressValidation {
  valid: boolean;
  error?: AddressValidationError;
  /** Present when the address decoded, even if it failed a later rule. */
  witnessVersion?: number;
  hrp?: string;
  programHex?: string;
  /** Human-readable reason for UI display. */
  reason?: string;
}

const ADDRESS_ERROR_REASON: Record<AddressValidationError, string> = {
  EMPTY: "Enter a recipient address.",
  MALFORMED: "That doesn't look like a valid Pearl address.",
  WRONG_NETWORK: "That address is for a different network.",
  UNSUPPORTED_WITNESS_VERSION:
    "Only Taproot (P2TR) addresses are supported right now.",
  BAD_PROGRAM_LENGTH: "That address has an invalid length.",
};

/**
 * Validate a recipient address against the active network. P2TR (witness v1) is
 * the only acceptable SEND target in the MVP.
 */
export function validateAddress(
  address: string,
  network: Network,
): AddressValidation {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "EMPTY", reason: ADDRESS_ERROR_REASON.EMPTY };
  }

  const decoded = decodeSegwitAddress(trimmed);
  if (!decoded) {
    return {
      valid: false,
      error: "MALFORMED",
      reason: ADDRESS_ERROR_REASON.MALFORMED,
    };
  }

  const expectedHrp = HRP_BY_NETWORK[network];
  if (decoded.hrp !== expectedHrp) {
    return {
      valid: false,
      error: "WRONG_NETWORK",
      reason: ADDRESS_ERROR_REASON.WRONG_NETWORK,
      hrp: decoded.hrp,
      witnessVersion: decoded.witnessVersion,
      programHex: decoded.programHex,
    };
  }

  // Pearl programs are always 32 bytes.
  if (decoded.programLength !== 32) {
    return {
      valid: false,
      error: "BAD_PROGRAM_LENGTH",
      reason: ADDRESS_ERROR_REASON.BAD_PROGRAM_LENGTH,
      hrp: decoded.hrp,
      witnessVersion: decoded.witnessVersion,
      programHex: decoded.programHex,
    };
  }

  // MVP sends to P2TR (v1) only. v2 (P2MR) is recognised but not a send target.
  if (decoded.witnessVersion !== 1) {
    return {
      valid: false,
      error: "UNSUPPORTED_WITNESS_VERSION",
      reason: ADDRESS_ERROR_REASON.UNSUPPORTED_WITNESS_VERSION,
      hrp: decoded.hrp,
      witnessVersion: decoded.witnessVersion,
      programHex: decoded.programHex,
    };
  }

  return {
    valid: true,
    hrp: decoded.hrp,
    witnessVersion: decoded.witnessVersion,
    programHex: decoded.programHex,
  };
}

/** Convenience boolean check. */
export function isValidAddress(address: string, network: Network): boolean {
  return validateAddress(address, network).valid;
}

export type AmountValidationError =
  | "EMPTY"
  | "NOT_A_NUMBER"
  | "TOO_MANY_DECIMALS"
  | "ZERO_OR_NEGATIVE"
  | "BELOW_DUST"
  | "EXCEEDS_SUPPLY";

export interface AmountValidation {
  valid: boolean;
  error?: AmountValidationError;
  /** The parsed amount in Grain, present when parsing succeeded. */
  grain?: Grain;
  reason?: string;
}

/**
 * Validate a user-entered PRL amount string and return it as Grain. Enforces:
 * non-empty, numeric with <=8 decimals, strictly positive, at or above the dust
 * floor for a P2TR output, and within the supply cap.
 */
export function validateAmount(input: string): AmountValidation {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "EMPTY", reason: "Enter an amount." };
  }

  let grain: Grain;
  try {
    grain = prlToGrain(trimmed);
  } catch (err) {
    if (err instanceof AmountError) {
      const tooManyDecimals = /decimal/i.test(err.message);
      return {
        valid: false,
        error: tooManyDecimals ? "TOO_MANY_DECIMALS" : "NOT_A_NUMBER",
        reason: tooManyDecimals
          ? "PRL supports at most 8 decimal places."
          : "Enter a valid PRL amount.",
      };
    }
    return {
      valid: false,
      error: "NOT_A_NUMBER",
      reason: "Enter a valid PRL amount.",
    };
  }

  if (grain <= 0n) {
    return {
      valid: false,
      error: "ZERO_OR_NEGATIVE",
      grain,
      reason: "Amount must be greater than zero.",
    };
  }
  if (grain < DUST_THRESHOLD_GRAIN) {
    return {
      valid: false,
      error: "BELOW_DUST",
      grain,
      reason: "Amount is below the dust threshold.",
    };
  }
  if (grain > MAX_GRAIN) {
    return {
      valid: false,
      error: "EXCEEDS_SUPPLY",
      grain,
      reason: "Amount exceeds the total supply.",
    };
  }

  return { valid: true, grain };
}
