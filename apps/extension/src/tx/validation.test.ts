import { describe, expect, it } from "vitest";
import { GRAIN_PER_PRL } from "@necklace/shared";
import { decodeSegwitAddress } from "./bech32m.js";
import { validateAddress, validateAmount } from "./validation.js";

/**
 * Pinned to the REAL Pearl KATs (node/btcutil/address_test.go, mirrored in
 * packages/wallet-core/fixtures/derived-address.json). The local bech32m parser
 * must reproduce these exactly: accept v1 P2TR, reject legacy v0 and bad lengths.
 */

const MAINNET_KAT =
  "prl1paardr2nczq0rx5rqpfwnvpzm497zvux64y0f7wjgcs7xuuuh2nnqksluzv";
const TESTNET_KAT =
  "tprl1paardr2nczq0rx5rqpfwnvpzm497zvux64y0f7wjgcs7xuuuh2nnqalmzae";
const KAT_PROGRAM =
  "ef46d1aa78101e3350600a5d36045ba97c2670daa91e9f3a48c43c6e739754e6";

describe("decodeSegwitAddress (bech32m KAT parity)", () => {
  it("decodes the mainnet P2TR KAT to the exact 32-byte program", () => {
    const d = decodeSegwitAddress(MAINNET_KAT);
    expect(d).not.toBeNull();
    expect(d!.hrp).toBe("prl");
    expect(d!.witnessVersion).toBe(1);
    expect(d!.programLength).toBe(32);
    expect(d!.programHex).toBe(KAT_PROGRAM);
  });

  it("decodes the testnet P2TR KAT (same program, different HRP)", () => {
    const d = decodeSegwitAddress(TESTNET_KAT);
    expect(d!.hrp).toBe("tprl");
    expect(d!.programHex).toBe(KAT_PROGRAM);
  });

  it("rejects legacy bech32 v0 (P2WPKH)", () => {
    expect(
      decodeSegwitAddress("prl1qw508d6qejxtdg4y5r3zarvary0c5xw7k34d768"),
    ).toBeNull();
  });

  it("rejects a corrupted checksum", () => {
    expect(decodeSegwitAddress(MAINNET_KAT.slice(0, -1) + "x")).toBeNull();
  });

  it("rejects mixed-case input", () => {
    const mixed = MAINNET_KAT.slice(0, 20) + MAINNET_KAT.slice(20).toUpperCase();
    expect(decodeSegwitAddress(mixed)).toBeNull();
  });
});

describe("validateAddress (network-aware)", () => {
  it("accepts a testnet P2TR on testnet", () => {
    expect(validateAddress(TESTNET_KAT, "testnet").valid).toBe(true);
  });

  it("rejects a mainnet address on regtest as WRONG_NETWORK", () => {
    const v = validateAddress(MAINNET_KAT, "regtest");
    expect(v.valid).toBe(false);
    expect(v.error).toBe("WRONG_NETWORK");
  });

  it("rejects empty input", () => {
    expect(validateAddress("   ", "mainnet").error).toBe("EMPTY");
  });

  it("rejects legacy v0 as MALFORMED (v0 fails bech32m decode)", () => {
    const v = validateAddress(
      "prl1qw508d6qejxtdg4y5r3zarvary0c5xw7k34d768",
      "mainnet",
    );
    expect(v.valid).toBe(false);
    expect(v.error).toBe("MALFORMED");
  });
});

describe("validateAmount", () => {
  it("parses 1.5 PRL to grain", () => {
    const v = validateAmount("1.5");
    expect(v.valid).toBe(true);
    expect(v.grain).toBe((GRAIN_PER_PRL * 3n) / 2n);
  });

  it("rejects >8 decimals", () => {
    expect(validateAmount("0.000000001").error).toBe("TOO_MANY_DECIMALS");
  });

  it("rejects zero", () => {
    expect(validateAmount("0").error).toBe("ZERO_OR_NEGATIVE");
  });

  it("rejects sub-dust amounts", () => {
    expect(validateAmount("0.00000001").error).toBe("BELOW_DUST");
  });

  it("rejects non-numeric input", () => {
    expect(validateAmount("abc").error).toBe("NOT_A_NUMBER");
  });
});
