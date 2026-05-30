/**
 * BlockbookClient — a {@link ChainClient} backed by a Pearl Blockbook instance
 * (the Trezor "blockbook" v2 API).
 *
 * This lets the extension read balance / UTXOs / history and broadcast a signed
 * raw transaction from a PUBLIC Pearl Blockbook, with NO self-hosted
 * pearld + indexer. It implements the same {@link ChainClient} interface as
 * {@link ApiClient}, so the UI and send-flow are unchanged — only the wiring in
 * `index.ts` (config-selected) differs.
 *
 * TRUST POSTURE (threat-model §2): Blockbook is UNTRUSTED for integrity. We
 *   - validate every response shape with zod and reject mismatches (BAD_RESPONSE);
 *   - NEVER trust it for a UTXO's scriptPubKey — we derive that LOCALLY from the
 *     queried (own) address via wallet-core, so a lying backend cannot change
 *     what the BIP-341 sighash commits to;
 *   - send only public data (addresses) and a fully-signed rawTxHex — never a
 *     key, seed, or password.
 * PRIVACY: like any light wallet, the provider observes which addresses we query.
 *
 * Source shapes verified against https://blockbook.pearlresearch.ai/api/v2
 * (Pearl mainnet, pearld 1.0.2, decimals=8 i.e. Grain). Amounts arrive as
 * decimal strings in the smallest unit (Grain); we parse to bigint with no float.
 */

import { z } from "zod";
import { decodeAddress } from "@necklace/wallet-core";
import type { Network } from "@necklace/shared";
import { ApiError } from "./errors.js";
import type { ChainClient } from "./client.js";
import type {
  ActivityTx,
  ApiUtxo,
  BalanceResponse,
  BroadcastResponse,
  FeesResponse,
  HealthResponse,
  TipResponse,
  TxDetail,
  TxIo,
  TxsResponse,
  UtxosResponse,
} from "./schemas.js";

const DEFAULT_TIMEOUT_MS = 15_000;
/** Pearl DefaultRelayFeePerKb in Grain/kB (docs/protocol-findings.md). */
const DEFAULT_RELAY_FEE_PER_KB = 1000n;
/** Coinbase maturity in blocks; immature coinbase UTXOs are unspendable. */
const COINBASE_MATURITY = 100;

export interface BlockbookClientConfig {
  /** Single HTTPS base URL, e.g. `https://blockbook.pearlresearch.ai`. */
  baseUrl: string;
  /** Network this Blockbook serves; reported back as the configured network. */
  network: Network;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// --- Blockbook wire schemas (untrusted → validated) ----------------------
const intStr = z.string().regex(/^\d+$/);
const signedIntStr = z.string().regex(/^-?\d+$/);
const txidHex = z.string().regex(/^[0-9a-f]{64}$/i);

const bbStatusSchema = z.object({
  blockbook: z.object({
    inSync: z.boolean().optional(),
    bestHeight: z.number().int().nonnegative().optional(),
    lastBlockTime: z.string().optional(),
  }),
  backend: z.object({
    chain: z.string(),
    blocks: z.number().int().nonnegative(),
    bestBlockHash: z.string().optional(),
    subversion: z.string().optional(),
  }),
});

const bbAddressSchema = z.object({
  address: z.string(),
  balance: intStr,
  unconfirmedBalance: signedIntStr.optional(),
});

const bbUtxoListSchema = z.array(
  z.object({
    txid: txidHex,
    vout: z.number().int().nonnegative(),
    value: intStr,
    height: z.number().int().optional(),
    confirmations: z.number().int().nonnegative().optional(),
    coinbase: z.boolean().optional(),
  }),
);

const bbTxSchema = z.object({
  txid: txidHex,
  blockHeight: z.number().int().optional(),
  confirmations: z.number().int().nonnegative().optional(),
  blockTime: z.number().int().nonnegative().optional(),
  fees: intStr.optional(),
  vin: z
    .array(z.object({ addresses: z.array(z.string()).optional(), value: intStr.optional() }))
    .default([]),
  vout: z
    .array(z.object({ addresses: z.array(z.string()).optional(), value: intStr.optional() }))
    .default([]),
});

const bbAddressTxsSchema = bbAddressSchema.extend({
  transactions: z.array(bbTxSchema).optional(),
});

/** Blockbook error envelope: `{error:"-22: ..."}` or `{error:{message}}`. */
const bbErrorSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]),
});
const bbSendOkSchema = z.object({ result: txidHex });

function errMessage(parsed: z.infer<typeof bbErrorSchema>): string {
  return typeof parsed.error === "string" ? parsed.error : parsed.error.message;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Map a node/relay error message to a stable ApiError kind. */
function mapBroadcastError(msg: string): ApiError {
  const m = msg.toLowerCase();
  if (/-27|already (known|in)|duplicate|txn-already/.test(m)) {
    return new ApiError("ALREADY_KNOWN", msg, { status: 409 });
  }
  if (/-22|decode|deserial|malformed|bad-txns-.*(small|length)/.test(m)) {
    return new ApiError("MALFORMED_TX", msg, {});
  }
  if (/-26|min relay fee|insufficient fee|fee.*too low|min-relay/.test(m)) {
    return new ApiError("INSUFFICIENT_FEE", msg, {});
  }
  return new ApiError("TX_REJECTED", msg, {});
}

export class BlockbookClient implements ChainClient {
  private readonly baseUrl: string;
  private readonly network: Network;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: BlockbookClientConfig) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "https:") {
      throw new Error("Blockbook base URL must be https");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.network = config.network;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get configuredNetwork(): Network {
    return this.network;
  }

  async health(): Promise<HealthResponse> {
    const s = this.parse(await this.getJson("/api/v2"), bbStatusSchema);
    return {
      status: s.blockbook.inSync ? "ok" : "syncing",
      network: this.network,
      nodeVersion: s.backend.subversion,
      synced: s.blockbook.inSync ?? false,
      tipHeight: s.backend.blocks,
    };
  }

  async tip(): Promise<TipResponse> {
    const s = this.parse(await this.getJson("/api/v2"), bbStatusSchema);
    const parsedMs = s.blockbook.lastBlockTime
      ? Date.parse(s.blockbook.lastBlockTime)
      : NaN;
    const time = Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : 0;
    return { height: s.backend.blocks, hash: s.backend.bestBlockHash ?? "", time };
  }

  async balance(address: string): Promise<BalanceResponse> {
    const a = this.parse(
      await this.getJson(`/api/v2/address/${encodeURIComponent(address)}`),
      bbAddressSchema,
    );
    const confirmed = BigInt(a.balance);
    const unconfirmed = a.unconfirmedBalance ? BigInt(a.unconfirmedBalance) : 0n;
    return { address, confirmed, unconfirmed, total: confirmed + unconfirmed };
  }

  async utxos(
    address: string,
    opts: { minConf?: number; limit?: number; cursor?: string } = {},
  ): Promise<UtxosResponse> {
    const list = this.parse(
      await this.getJson(`/api/v2/utxo/${encodeURIComponent(address)}`),
      bbUtxoListSchema,
    );
    // Derive the scriptPubKey LOCALLY from our own address — never trust the
    // backend for what the sighash will commit to. All entries pay to `address`.
    const pkScript = bytesToHex(decodeAddress(address).scriptPubKey);
    const minConf = opts.minConf ?? 0;
    const utxos: ApiUtxo[] = [];
    for (const u of list) {
      const confirmations = u.confirmations ?? 0;
      if (confirmations < minConf) continue;
      if (u.coinbase && confirmations < COINBASE_MATURITY) continue; // immature
      utxos.push({
        txid: u.txid.toLowerCase(),
        vout: u.vout,
        value: BigInt(u.value),
        pkScript,
        confirmations,
        height: u.height ?? null,
      });
    }
    return { address, utxos, cursor: null };
  }

  async txs(
    address: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<TxsResponse> {
    const pageSize = opts.limit ?? 25;
    const a = this.parse(
      await this.getJson(
        `/api/v2/address/${encodeURIComponent(address)}?details=txs&pageSize=${pageSize}`,
      ),
      bbAddressTxsSchema,
    );
    const txs: ActivityTx[] = (a.transactions ?? []).map((t) => {
      let received = 0n;
      let sent = 0n;
      for (const o of t.vout) {
        if (o.value && o.addresses?.includes(address)) received += BigInt(o.value);
      }
      for (const i of t.vin) {
        if (i.value && i.addresses?.includes(address)) sent += BigInt(i.value);
      }
      const netValue = received - sent;
      const direction = netValue > 0n ? "received" : netValue < 0n ? "sent" : "self";
      return {
        txid: t.txid.toLowerCase(),
        height: t.blockHeight ?? null,
        confirmations: t.confirmations ?? 0,
        time: t.blockTime ?? 0,
        netValue,
        ...(t.fees ? { fee: BigInt(t.fees) } : {}),
        direction,
      };
    });
    return { address, txs, cursor: null };
  }

  async tx(txid: string): Promise<TxDetail> {
    const t = this.parse(
      await this.getJson(`/api/v2/tx/${encodeURIComponent(txid)}`),
      bbTxSchema,
    );
    const inputs: TxIo[] = t.vin.map((v) => ({
      ...(v.addresses?.[0] ? { address: v.addresses[0] } : {}),
      value: v.value ? BigInt(v.value) : 0n,
    }));
    const outputs: TxIo[] = t.vout.map((o) => ({
      ...(o.addresses?.[0] ? { address: o.addresses[0] } : {}),
      value: o.value ? BigInt(o.value) : 0n,
    }));
    return {
      txid: t.txid.toLowerCase(),
      confirmations: t.confirmations ?? 0,
      time: t.blockTime ?? 0,
      height: t.blockHeight ?? null,
      ...(t.fees ? { fee: BigInt(t.fees) } : {}),
      inputs,
      outputs,
      valueOut: outputs.reduce((acc, o) => acc + o.value, 0n),
    };
  }

  async fees(): Promise<FeesResponse> {
    // MVP: Pearl's default relay fee. Blockbook /estimatefee can be wired later
    // once its unit (PRL vs Grain per kB) is pinned against a fixture.
    return { feePerKb: DEFAULT_RELAY_FEE_PER_KB, minRelayFeePerKb: DEFAULT_RELAY_FEE_PER_KB };
  }

  async broadcast(rawTxHex: string): Promise<BroadcastResponse> {
    const json = await this.postSendtx(rawTxHex);
    const ok = bbSendOkSchema.safeParse(json);
    if (ok.success) {
      return { txid: ok.data.result.toLowerCase(), accepted: true, alreadyKnown: false };
    }
    const err = bbErrorSchema.safeParse(json);
    if (err.success) throw mapBroadcastError(errMessage(err.data));
    throw new ApiError("BAD_RESPONSE", "Unexpected broadcast response", {});
  }

  // --- internals ---------------------------------------------------------

  private async getJson(path: string): Promise<unknown> {
    return this.json(await this.request(path, { method: "GET" }));
  }

  private async postSendtx(rawTxHex: string): Promise<unknown> {
    // Blockbook accepts the raw hex as the POST body at /api/v2/sendtx/.
    return this.json(
      await this.request("/api/v2/sendtx/", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: rawTxHex,
      }),
    );
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { accept: "application/json", ...init.headers },
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw new ApiError("NODE_DOWN", "Network request failed", {});
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read the JSON body (even on non-2xx, so callers can read an {error}). */
  private async json(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      if (!res.ok) {
        throw new ApiError(
          res.status >= 500 ? "NODE_DOWN" : "UNKNOWN",
          `Request failed (${res.status})`,
          { status: res.status },
        );
      }
      throw new ApiError("BAD_RESPONSE", "Response was not valid JSON", {
        status: res.status,
      });
    }
  }

  /** Reject a Blockbook {error} envelope, then validate against `schema`. */
  private parse<T>(json: unknown, schema: z.ZodType<T>): T {
    const err = bbErrorSchema.safeParse(json);
    if (err.success) {
      // A read returned an error envelope (bad/unknown address, node issue).
      throw new ApiError("UNKNOWN", errMessage(err.data), {});
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError("BAD_RESPONSE", "Response did not match schema", {});
    }
    return parsed.data;
  }
}
