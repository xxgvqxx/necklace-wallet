/**
 * Error taxonomy for the Railway API client.
 *
 * Every failure the UI can encounter is normalised into one {@link ApiError}
 * with a stable {@link ApiErrorKind}, so screens render a single, consistent
 * {@link ../components/ErrorState} regardless of whether the failure was a
 * network drop, a malformed response, or a node-level rejection. The raw
 * server `message` is carried through for display only — it is NEVER eval'd or
 * rendered as HTML (CSP + React text nodes guarantee inertness).
 *
 * No secrets ever reach this layer (requests carry only public addresses and
 * already-signed tx hex), so error objects are safe to surface and to log
 * without leaking key material.
 */

/** Stable, machine-readable failure kinds the UI switches on. */
export type ApiErrorKind =
  /** Node/indexer unreachable, or the fetch itself failed (offline, DNS, TLS). */
  | "NODE_DOWN"
  /** Bad/empty/invalid request param (e.g. address) — should be rare given local validation. */
  | "MALFORMED"
  /** Address HRP doesn't match the deployment network. */
  | "WRONG_NETWORK"
  /** rawTxHex not valid/deserializable — a build/sign bug; do NOT blind-retry. */
  | "MALFORMED_TX"
  /** Node rejected the signed tx (bad sig, non-standard, low fee, spent inputs, dust, double-spend). */
  | "TX_REJECTED"
  /** Fee under relay floor (optional, more specific than TX_REJECTED). */
  | "INSUFFICIENT_FEE"
  /** Tx already in mempool/chain. SUCCESS-EQUIVALENT — surfaced for completeness. */
  | "ALREADY_KNOWN"
  /** Response did not match the expected schema. The API is untrusted; reject. */
  | "BAD_RESPONSE"
  /** Anything else (unexpected status, etc.). */
  | "UNKNOWN";

const KIND_FROM_CODE: Record<string, ApiErrorKind> = {
  MALFORMED: "MALFORMED",
  WRONG_NETWORK: "WRONG_NETWORK",
  MALFORMED_TX: "MALFORMED_TX",
  TX_REJECTED: "TX_REJECTED",
  INSUFFICIENT_FEE: "INSUFFICIENT_FEE",
  ALREADY_KNOWN: "ALREADY_KNOWN",
  NODE_DOWN: "NODE_DOWN",
};

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status, if the request reached the server. */
  readonly status?: number;
  /** The server-provided `code`, if any. */
  readonly code?: string;

  constructor(
    kind: ApiErrorKind,
    message: string,
    opts: { status?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = opts.status;
    this.code = opts.code;
  }

  /** Maps a server error `code` (api-contract §9) to an {@link ApiErrorKind}. */
  static fromCode(
    code: string,
    message: string,
    status?: number,
  ): ApiError {
    const kind = KIND_FROM_CODE[code] ?? "UNKNOWN";
    return new ApiError(kind, message, { status, code });
  }
}

/** True for the duplicate-broadcast case, which callers treat as success. */
export function isAlreadyKnown(err: unknown): boolean {
  return err instanceof ApiError && err.kind === "ALREADY_KNOWN";
}

/**
 * A short, human-readable phrase for each error kind. Screens may show this or
 * prefer the server `message` when present; either way the text is inert.
 */
export function humanizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case "NODE_DOWN":
        return "Can't reach the Pearl network right now. Check your connection and try again.";
      case "WRONG_NETWORK":
        return "That address is for a different network.";
      case "MALFORMED":
        return "The request was rejected as malformed.";
      case "MALFORMED_TX":
        return "The transaction could not be read by the node. Please try rebuilding it.";
      case "TX_REJECTED":
        return err.message || "The network rejected the transaction.";
      case "INSUFFICIENT_FEE":
        return "The network fee was below the minimum. Increase the fee and try again.";
      case "ALREADY_KNOWN":
        return "This transaction is already on the network.";
      case "BAD_RESPONSE":
        return "The server returned an unexpected response.";
      default:
        return err.message || "Something went wrong.";
    }
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
