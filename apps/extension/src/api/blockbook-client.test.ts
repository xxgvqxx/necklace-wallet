/**
 * BlockbookClient mapping tests — no network. A fake `fetchImpl` returns the
 * exact shapes the live Pearl Blockbook returns (verified against
 * https://blockbook.pearlresearch.ai/api/v2), and we assert the mapping into the
 * extension's internal types + the security-relevant behaviours:
 *   - amounts (decimal Grain strings) become bigint with no float;
 *   - a UTXO's pkScript is derived LOCALLY from the address (not the backend);
 *   - immature coinbase UTXOs are filtered;
 *   - broadcast result/error map to the right ApiError kinds.
 */

import { describe, it, expect } from "vitest";
import { BlockbookClient } from "./blockbook-client.js";
import { ApiError } from "./errors.js";

// Real Pearl mainnet P2TR KAT (node/btcutil/address_test.go).
const ADDR = "prl1paardr2nczq0rx5rqpfwnvpzm497zvux64y0f7wjgcs7xuuuh2nnqksluzv";
// Its scriptPubKey = OP_1 (0x51) PUSH32 (0x20) || 32-byte witness program.
const PKSCRIPT =
  "5120ef46d1aa78101e3350600a5d36045ba97c2670daa91e9f3a48c43c6e739754e6";
const TXID = "ae69d2aebf567b7b169e73ca23cc2807ccb0796f8e8d5167547ea482a0ed16b8";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build a client whose fetch is routed by a per-test handler. */
function client(handler: (url: string, init?: RequestInit) => Response): BlockbookClient {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as unknown as typeof fetch;
  return new BlockbookClient({ baseUrl: "https://bb.example", network: "mainnet", fetchImpl });
}

describe("BlockbookClient", () => {
  it("rejects a non-https base URL", () => {
    expect(() => new BlockbookClient({ baseUrl: "http://bb.example", network: "mainnet" })).toThrow();
  });

  it("maps balance (Grain strings -> bigint, total = confirmed + unconfirmed)", async () => {
    const c = client((url) => {
      expect(url).toContain(`/api/v2/address/${ADDR}`);
      return jsonResponse({
        address: ADDR,
        balance: "1500000000",
        unconfirmedBalance: "500000000",
        txs: 3,
      });
    });
    const b = await c.balance(ADDR);
    expect(b.confirmed).toBe(1_500_000_000n);
    expect(b.unconfirmed).toBe(500_000_000n);
    expect(b.total).toBe(2_000_000_000n);
  });

  it("derives the UTXO pkScript LOCALLY from the address and filters immature coinbase", async () => {
    const c = client((url) => {
      expect(url).toContain(`/api/v2/utxo/${ADDR}`);
      return jsonResponse([
        { txid: TXID, vout: 0, value: "322964134063", confirmations: 105, height: 1 },
        // immature coinbase -> must be filtered out
        { txid: TXID.replace(/a/g, "b"), vout: 0, value: "5000000000", confirmations: 5, coinbase: true },
      ]);
    });
    const r = await c.utxos(ADDR);
    expect(r.utxos).toHaveLength(1);
    expect(r.utxos[0]?.pkScript).toBe(PKSCRIPT);
    expect(r.utxos[0]?.value).toBe(322_964_134_063n);
    expect(r.utxos[0]?.txid).toBe(TXID);
  });

  it("maps health from /api/v2 status", async () => {
    const c = client(() =>
      jsonResponse({
        blockbook: { inSync: true, bestHeight: 63712, lastBlockTime: "2026-05-29T18:27:53Z" },
        backend: { chain: "mainnet", blocks: 63712, bestBlockHash: "abcd", subversion: "/pearld:1.0.2/" },
      }),
    );
    const h = await c.health();
    expect(h.synced).toBe(true);
    expect(h.network).toBe("mainnet");
    expect(h.tipHeight).toBe(63712);
  });

  it("broadcast: maps {result} to accepted txid", async () => {
    const c = client((url, init) => {
      expect(url).toContain("/api/v2/sendtx/");
      expect(init?.method).toBe("POST");
      return jsonResponse({ result: TXID });
    });
    const r = await c.broadcast("0100000000");
    expect(r.accepted).toBe(true);
    expect(r.txid).toBe(TXID);
  });

  it("broadcast: TX decode error -> MALFORMED_TX", async () => {
    const c = client(() => jsonResponse({ error: "-22: TX decode failed: EOF" }));
    await expect(c.broadcast("deadbeef")).rejects.toMatchObject({
      name: "ApiError",
      kind: "MALFORMED_TX",
    });
  });

  it("broadcast: already-known -> ALREADY_KNOWN (success-equivalent)", async () => {
    const c = client(() =>
      jsonResponse({ error: "-27: transaction already in block chain" }),
    );
    const err = await c.broadcast("0100000000").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("ALREADY_KNOWN");
  });

  it("rejects a malformed response shape as BAD_RESPONSE", async () => {
    const c = client(() => jsonResponse({ totally: "wrong" }));
    await expect(c.balance(ADDR)).rejects.toMatchObject({ kind: "BAD_RESPONSE" });
  });
});
