/**
 * PRL amount helpers.
 *
 * Phase 1 fee units (`node/btcutil/amount.go`, `node/btcutil/const.go`):
 *   smallest unit = "Grain"; 1 PRL = 1e8 Grain (8 decimals, like satoshis).
 *   supply cap = 21e9 PRL  =>  MaxGrain = 21e9 * 1e8.
 *   units ladder: MPRL(1e6 PRL), kPRL(1e3), PRL, mPRL(1e-3), uPRL(1e-6), Grain(1e-8).
 *
 * Amounts are represented as bigint Grain because the supply cap exceeds
 * Number.MAX_SAFE_INTEGER and float math is never acceptable for money.
 */

import type { Grain } from "./types.js";

/** Grain per whole PRL. */
export const GRAIN_PER_PRL = 100_000_000n; // 1e8

/** Number of decimal places PRL is displayed with. */
export const PRL_DECIMALS = 8;

/** Total supply cap, in PRL. */
export const MAX_PRL = 21_000_000_000n; // 21e9

/** Total supply cap, in Grain. */
export const MAX_GRAIN: Grain = MAX_PRL * GRAIN_PER_PRL; // 21e9 * 1e8

/**
 * Dust floor for a P2TR output, in Grain. The Necklace fee output and any change
 * output must be at or above this. ~546 Grain per Phase 1 findings.
 */
export const DUST_THRESHOLD_GRAIN: Grain = 546n;

/** Unit names and their value expressed in Grain. */
export const UNIT_IN_GRAIN = {
  MPRL: GRAIN_PER_PRL * 1_000_000n,
  kPRL: GRAIN_PER_PRL * 1_000n,
  PRL: GRAIN_PER_PRL,
  mPRL: GRAIN_PER_PRL / 1_000n, // 1e5
  uPRL: GRAIN_PER_PRL / 1_000_000n, // 1e2
  Grain: 1n,
} as const;

export type PrlUnit = keyof typeof UNIT_IN_GRAIN;

/** Thrown when a value is outside the representable / valid range. */
export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

/** Returns true if a Grain amount is within [0, MAX_GRAIN]. */
export function isValidGrain(grain: Grain): boolean {
  return grain >= 0n && grain <= MAX_GRAIN;
}

/** Asserts a Grain amount is in range, throwing AmountError otherwise. */
export function assertValidGrain(grain: Grain): void {
  if (grain < 0n) throw new AmountError("amount is negative");
  if (grain > MAX_GRAIN) throw new AmountError("amount exceeds supply cap");
}

/**
 * Parses a decimal PRL string (e.g. "1.5", "0.00000001") into Grain.
 * Rejects more than 8 fractional digits and non-numeric input. No floats are
 * used anywhere in the conversion.
 */
export function prlToGrain(prl: string): Grain {
  const trimmed = prl.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new AmountError(`invalid PRL amount: "${prl}"`);

  const [, sign = "", whole = "0", frac = ""] = match;
  if (frac.length > PRL_DECIMALS) {
    throw new AmountError(
      `too many decimal places (max ${PRL_DECIMALS}): "${prl}"`,
    );
  }

  const fracPadded = frac.padEnd(PRL_DECIMALS, "0");
  const grain = BigInt(whole) * GRAIN_PER_PRL + BigInt(fracPadded || "0");
  const signed = sign === "-" ? -grain : grain;
  assertValidGrain(signed);
  return signed;
}

/**
 * Formats Grain as a decimal PRL string. Trailing zeros are trimmed unless
 * `trimTrailingZeros` is false; the value is never rendered via Number.
 */
export function grainToPrl(
  grain: Grain,
  opts: { trimTrailingZeros?: boolean } = {},
): string {
  const { trimTrailingZeros = true } = opts;
  const negative = grain < 0n;
  const abs = negative ? -grain : grain;

  const whole = abs / GRAIN_PER_PRL;
  const frac = abs % GRAIN_PER_PRL;

  let fracStr = frac.toString().padStart(PRL_DECIMALS, "0");
  if (trimTrailingZeros) {
    fracStr = fracStr.replace(/0+$/, "");
  }

  const body = fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** Converts a value expressed in `unit` to Grain. Fractional input is parsed exactly. */
export function unitToGrain(value: string, unit: PrlUnit): Grain {
  const factor = UNIT_IN_GRAIN[unit];
  if (unit === "PRL") return prlToGrain(value);

  // Convert via PRL to reuse exact decimal parsing, then scale.
  // value(unit) * (UNIT_IN_GRAIN[unit]) === grain, but value may be fractional,
  // so parse against the unit's own decimal granularity.
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new AmountError(`invalid ${unit} amount: "${value}"`);
  const [, sign = "", whole = "0", frac = ""] = match;

  // Smallest fraction of this unit that is still a whole Grain.
  const unitDecimals = decimalsForUnit(factor);
  if (frac.length > unitDecimals) {
    throw new AmountError(
      `too many decimal places for ${unit} (max ${unitDecimals}): "${value}"`,
    );
  }
  const fracPadded = frac.padEnd(unitDecimals, "0");
  const scaled =
    BigInt(whole) * factor +
    (fracPadded ? BigInt(fracPadded) * (factor / 10n ** BigInt(unitDecimals)) : 0n);
  const signed = sign === "-" ? -scaled : scaled;
  assertValidGrain(signed);
  return signed;
}

/** How many decimal places a unit supports before hitting sub-Grain precision. */
function decimalsForUnit(unitInGrain: Grain): number {
  // log10(unitInGrain) capped at 0; e.g. PRL(1e8)->8, mPRL(1e5)->5, Grain(1)->0.
  let n = 0;
  let v = unitInGrain;
  while (v > 1n) {
    v /= 10n;
    n += 1;
  }
  return n;
}

/** Sums a list of Grain amounts. */
export function sumGrain(amounts: readonly Grain[]): Grain {
  return amounts.reduce((acc, x) => acc + x, 0n);
}
