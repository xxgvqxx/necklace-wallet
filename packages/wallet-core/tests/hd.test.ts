/**
 * BIP-39 -> BIP-32 -> BIP-86 HD derivation, pinned to known-answer vectors in
 * fixtures/hd-bip86.json.
 *
 * The decisive check is the BIP-86 spec cross-reference: deriving the canonical
 * "abandon … about" mnemonic at m/86'/0'/0'/0/0 (Bitcoin coin 0') and applying
 * the TapTweak MUST reproduce the output key published in BIP-86 itself
 * (a60869f0…). That proves the @scure/bip32 derivation and the address.ts tweak
 * are correct against an external reference; the Pearl-network vectors then
 * follow by changing only the coin type + HRP.
 */

import { describe, expect, it } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  bip86Path,
  deriveBip86AddressFromMnemonic,
  deriveBip86AddressFromXpub,
  deriveBip86KeyFromMnemonic,
  generateMnemonic,
  isValidMnemonic,
  HdError,
} from "../src/hd.js";
import { deriveAddress, tapTweakOutputKey } from "../src/address.js";
import type { Network } from "@necklace/shared";
import { bytesToHex, loadFixture } from "./fixtures.js";

interface HdVector {
  network: Network;
  path: string;
  privateKeyHex: string;
  xOnlyPublicKeyHex: string;
  address: string;
}
interface HdFixture {
  mnemonic: string;
  passphrase: string;
  bip86SpecCrossCheck: { path: string; internalXOnly: string; outputKey: string };
  watchOnlyXpub: { xpub: string; childRegtestAddress: string };
  vectors: HdVector[];
}

const fx = loadFixture<HdFixture>("hd-bip86.json");

describe("BIP-86 spec cross-reference (external proof of correctness)", () => {
  it("reproduces the published BIP-86 output key at m/86'/0'/0'/0/0", () => {
    const seed = mnemonicToSeedSync(fx.mnemonic, fx.passphrase);
    const node = HDKey.fromMasterSeed(seed).derive(fx.bip86SpecCrossCheck.path);
    const internal = node.publicKey!.slice(1);
    expect(bytesToHex(internal)).toBe(fx.bip86SpecCrossCheck.internalXOnly);
    const { outputKey } = tapTweakOutputKey(internal);
    expect(bytesToHex(outputKey)).toBe(fx.bip86SpecCrossCheck.outputKey);
  });
});

describe("BIP-86 per-network KAT vectors", () => {
  for (const v of fx.vectors) {
    it(`derives KEY BYTES for ${v.network} at ${v.path}`, () => {
      const k = deriveBip86KeyFromMnemonic(fx.mnemonic, v.network, {}, fx.passphrase);
      expect(k.path).toBe(v.path);
      expect(bytesToHex(k.privateKey)).toBe(v.privateKeyHex);
      expect(bytesToHex(k.xOnlyPublicKey)).toBe(v.xOnlyPublicKeyHex);
    });

    it(`encodes the Pearl address for ${v.network}`, () => {
      const a = deriveBip86AddressFromMnemonic(fx.mnemonic, v.network, {}, fx.passphrase);
      expect(a.address).toBe(v.address);
      expect(a.path).toBe(v.path);
      // The address must equal what deriveAddress produces from the derived key.
      const k = deriveBip86KeyFromMnemonic(fx.mnemonic, v.network, {}, fx.passphrase);
      expect(deriveAddress(k.privateKey, v.network).address).toBe(v.address);
    });
  }

  it("derives identical keys for testnet and regtest (shared coin type 1)", () => {
    const t = deriveBip86KeyFromMnemonic(fx.mnemonic, "testnet", {}, fx.passphrase);
    const r = deriveBip86KeyFromMnemonic(fx.mnemonic, "regtest", {}, fx.passphrase);
    expect(bytesToHex(t.privateKey)).toBe(bytesToHex(r.privateKey));
  });

  it("builds the BIP-86 path with the per-network coin type", () => {
    expect(bip86Path("mainnet")).toBe("m/86'/808276'/0'/0/0");
    expect(bip86Path("regtest")).toBe("m/86'/1'/0'/0/0");
    expect(bip86Path("testnet", { change: 1, index: 3 })).toBe("m/86'/1'/0'/1/3");
  });
});

describe("watch-only xpub child derivation", () => {
  it("derives the SAME address publicly that the mnemonic derives privately", () => {
    const a = deriveBip86AddressFromXpub(fx.watchOnlyXpub.xpub, "regtest", {
      change: 0,
      index: 0,
    });
    expect(a.address).toBe(fx.watchOnlyXpub.childRegtestAddress);
    // It equals the regtest private-key vector — public and private paths agree.
    const reg = fx.vectors.find((v) => v.network === "regtest")!;
    expect(a.address).toBe(reg.address);
  });

  it("rejects a private extended key passed as an xpub", () => {
    const seed = mnemonicToSeedSync(fx.mnemonic, fx.passphrase);
    const xprv = HDKey.fromMasterSeed(seed).derive("m/86'/1'/0'").privateExtendedKey;
    expect(() => deriveBip86AddressFromXpub(xprv, "regtest")).toThrow(HdError);
  });

  it("rejects a garbage xpub", () => {
    expect(() => deriveBip86AddressFromXpub("not-an-xpub", "regtest")).toThrow(HdError);
  });
});

describe("mnemonic generation + validation", () => {
  it("generates a valid 12-word mnemonic by default", () => {
    const m = generateMnemonic();
    expect(m.split(" ")).toHaveLength(12);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it("generates a valid 24-word mnemonic", () => {
    const m = generateMnemonic(24);
    expect(m.split(" ")).toHaveLength(24);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it("rejects an invalid mnemonic (bad checksum)", () => {
    expect(isValidMnemonic("abandon abandon abandon")).toBe(false);
    expect(() =>
      deriveBip86KeyFromMnemonic("abandon abandon abandon", "regtest"),
    ).toThrow(HdError);
  });

  it("a BIP-39 passphrase changes the derived key", () => {
    const a = deriveBip86KeyFromMnemonic(fx.mnemonic, "regtest", {}, "");
    const b = deriveBip86KeyFromMnemonic(fx.mnemonic, "regtest", {}, "TREZOR");
    expect(bytesToHex(a.privateKey)).not.toBe(bytesToHex(b.privateKey));
  });
});
