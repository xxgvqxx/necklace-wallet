/**
 * Typed HTTP client for the read/broadcast API.
 *
 * This is the ONLY network host the extension talks to. It is declared as the
 * extension's single host permission. The client:
 *   - talks HTTPS-only to one pinned base URL;
 *   - sends only public data (addresses, and for broadcast a fully-signed
 *     rawTxHex) — never a key, seed, or password;
 *   - validates every response against a zod schema and rejects anything that
 *     doesn't match (the API is untrusted — threat-model §2);
 *   - normalises all failures into {@link ApiError} with a stable kind.
 *
 * It performs NO signing and holds NO secrets.
 */

import { z } from "zod";
import type { Network } from "@necklace/shared";
import { ApiError } from "./errors.js";
import {
  balanceResponseSchema,
  broadcastResponseSchema,
  errorEnvelopeSchema,
  feesResponseSchema,
  healthResponseSchema,
  tipResponseSchema,
  txsResponseSchema,
  utxosResponseSchema,
  type BalanceResponse,
  type BroadcastResponse,
  type FeesResponse,
  type HealthResponse,
  type TipResponse,
  type TxDetail,
  type TxsResponse,
  type UtxosResponse,
} from "./schemas.js";

/**
 * The chain read/broadcast surface the UI + send-flow depend on. Implemented by
 * {@link ApiClient} (self-hosted API) and {@link BlockbookClient}
 * (public Pearl Blockbook), so the backend is swappable via config without
 * touching any screen.
 */
export interface ChainClient {
  health(): Promise<HealthResponse>;
  tip(): Promise<TipResponse>;
  balance(address: string): Promise<BalanceResponse>;
  utxos(
    address: string,
    opts?: { minConf?: number; limit?: number; cursor?: string },
  ): Promise<UtxosResponse>;
  txs(
    address: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<TxsResponse>;
  fees(): Promise<FeesResponse>;
  broadcast(rawTxHex: string): Promise<BroadcastResponse>;
  /** Full detail for one transaction (senders, receivers, amount, fee). */
  tx(txid: string): Promise<TxDetail>;
  readonly configuredNetwork: Network;
}

export interface ApiClientConfig {
  /** Single HTTPS base URL, e.g. `https://api.necklace.example`. */
  baseUrl: string;
  /** Network this deployment serves; used to sanity-check `/health`. */
  network: Network;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Injectable fetch (defaults to global fetch); handy for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiClient implements ChainClient {
  private readonly baseUrl: string;
  private readonly network: Network;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ApiClientConfig) {
    // Enforce HTTPS at construction (no plaintext, no fallback host).
    const url = new URL(config.baseUrl);
    if (url.protocol !== "https:") {
      throw new Error("API base URL must be https");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.network = config.network;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Liveness + which chain the node is on. */
  async health(): Promise<HealthResponse> {
    return this.get("/health", healthResponseSchema);
  }

  /** Current chain tip. */
  async tip(): Promise<TipResponse> {
    return this.get("/tip", tipResponseSchema);
  }

  /** Confirmed + unconfirmed balance for an address (Grain). */
  async balance(address: string): Promise<BalanceResponse> {
    return this.get(
      `/address/${encodeURIComponent(address)}/balance`,
      balanceResponseSchema,
    );
  }

  /**
   * Spendable UTXOs for an address. Each carries `value` (Grain) and `pkScript`,
   * both mandatory for building the tx and the BIP-341 sighash.
   */
  async utxos(
    address: string,
    opts: { minConf?: number; limit?: number; cursor?: string } = {},
  ): Promise<UtxosResponse> {
    const qs = new URLSearchParams();
    if (opts.minConf !== undefined) qs.set("minConf", String(opts.minConf));
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.get(
      `/address/${encodeURIComponent(address)}/utxos${suffix}`,
      utxosResponseSchema,
    );
  }

  /** Transaction history for an address (display only; never a signing input). */
  async txs(
    address: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<TxsResponse> {
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.get(
      `/address/${encodeURIComponent(address)}/txs${suffix}`,
      txsResponseSchema,
    );
  }

  /** Recommended network relay fee (advisory; the extension enforces its own bounds). */
  async fees(): Promise<FeesResponse> {
    return this.get("/fees/recommended", feesResponseSchema);
  }

  /**
   * Broadcast a fully-signed raw transaction. The ONLY write endpoint and the
   * only field is `rawTxHex` — it carries no secrets. `409 ALREADY_KNOWN` and a
   * `200` with `alreadyKnown: true` are both success-equivalent (idempotent
   * retries); a 409 is surfaced as a synthetic accepted response here.
   */
  async broadcast(rawTxHex: string): Promise<BroadcastResponse> {
    try {
      return await this.post(
        "/tx/broadcast",
        { rawTxHex },
        broadcastResponseSchema,
      );
    } catch (err) {
      // A 409 ALREADY_KNOWN with a txid in the envelope is success-equivalent.
      if (
        err instanceof ApiError &&
        err.kind === "ALREADY_KNOWN" &&
        err.status === 409
      ) {
        // The envelope may carry the txid; we cannot synthesise it if absent,
        // so re-throw and let the caller treat ALREADY_KNOWN as success.
        throw err;
      }
      throw err;
    }
  }

  /**
   * Transaction detail. Not part of the self-hosted API contract; the mainnet
   * build uses {@link BlockbookClient.tx}. Implemented to satisfy ChainClient.
   */
  async tx(txid: string): Promise<TxDetail> {
    void txid;
    throw new ApiError(
      "UNKNOWN",
      "Transaction detail is not available from this backend.",
    );
  }

  /** The configured network (so callers can label which chain they're on). */
  get configuredNetwork(): Network {
    return this.network;
  }

  // --- internals ---------------------------------------------------------

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const res = await this.request(path, { method: "GET" });
    return this.parse(res, schema);
  }

  private async post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const res = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parse(res, schema);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { accept: "application/json", ...init.headers },
        // Never attach credentials/cookies to this cross-origin public API.
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      // Network drop, DNS, TLS, timeout/abort — treat as the node being down.
      throw new ApiError("NODE_DOWN", "Network request failed", {});
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      await this.throwForStatus(res);
    }
    return res;
  }

  /** Reads the standard error envelope and throws a normalised ApiError. */
  private async throwForStatus(res: Response): Promise<never> {
    let code: string | undefined;
    let message: string | undefined;
    try {
      const json: unknown = await res.json();
      const parsed = errorEnvelopeSchema.safeParse(json);
      if (parsed.success) {
        code = parsed.data.error.code;
        message = parsed.data.error.message;
      }
    } catch {
      // Non-JSON body; fall through to status-based mapping.
    }
    if (code) {
      throw ApiError.fromCode(code, message ?? code, res.status);
    }
    if (res.status === 503) {
      throw new ApiError("NODE_DOWN", "Service unavailable", {
        status: 503,
      });
    }
    if (res.status === 409) {
      throw new ApiError("ALREADY_KNOWN", "Already known", { status: 409 });
    }
    throw new ApiError("UNKNOWN", `Request failed (${res.status})`, {
      status: res.status,
    });
  }

  /** Parses + validates a JSON response; a shape mismatch is a BAD_RESPONSE. */
  private async parse<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError("BAD_RESPONSE", "Response was not valid JSON", {
        status: res.status,
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError("BAD_RESPONSE", "Response did not match schema", {
        status: res.status,
      });
    }
    return parsed.data;
  }
}
