import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: typeof fetch): ApiClient {
  return new ApiClient({
    baseUrl: "https://api.necklace.example",
    network: "regtest",
    fetchImpl,
  });
}

describe("ApiClient construction", () => {
  it("rejects a non-HTTPS base URL", () => {
    expect(
      () => new ApiClient({ baseUrl: "http://insecure.example", network: "regtest" }),
    ).toThrow(/https/);
  });
});

describe("ApiClient response validation (untrusted API)", () => {
  it("parses a well-formed balance response into bigint Grain", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        address: "rprl1pxyz",
        confirmed: 150000000,
        unconfirmed: 0,
        total: 150000000,
      }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    const res = await client.balance("rprl1pxyz");
    expect(res.confirmed).toBe(150000000n);
    expect(typeof res.confirmed).toBe("bigint");
  });

  it("rejects a malformed response shape as BAD_RESPONSE", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ address: "rprl1pxyz", confirmed: "not-a-number" }),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(client.balance("rprl1pxyz")).rejects.toMatchObject({
      kind: "BAD_RESPONSE",
    });
  });

  it("maps a server error envelope code to an ApiErrorKind", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: "TX_REJECTED", message: "fee too low" } },
        400,
      ),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(client.broadcast("00")).rejects.toMatchObject({
      kind: "TX_REJECTED",
      message: "fee too low",
    });
  });

  it("treats a network failure as NODE_DOWN", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(client.tip()).rejects.toMatchObject({ kind: "NODE_DOWN" });
  });
});

describe("ApiClient broadcast sends only rawTxHex (no secrets)", () => {
  it("posts exactly { rawTxHex } and nothing else", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return jsonResponse({ txid: "a".repeat(64), accepted: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    const res = await client.broadcast("01000000abcdef");
    expect(res.accepted).toBe(true);

    expect(captured).not.toBeNull();
    const body = JSON.parse(captured!.init.body as string);
    expect(Object.keys(body)).toEqual(["rawTxHex"]);
    expect(body.rawTxHex).toBe("01000000abcdef");
    // No credentials/cookies attached.
    expect(captured!.init.credentials).toBe("omit");
  });

  it("propagates ALREADY_KNOWN (409) for the caller to treat as success", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "ALREADY_KNOWN" } }, 409),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(client.broadcast("00")).rejects.toMatchObject({
      kind: "ALREADY_KNOWN",
      status: 409,
    });
  });
});
