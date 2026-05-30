/**
 * Fixture loader shared by the golden-fixture tests.
 *
 * Fixtures live in ../fixtures/*.json and are the REAL Pearl KATs (address,
 * WIF) plus illustrative regtest shapes (utxos, unsigned/signed tx). Tests read
 * them at runtime so a fixture edit is picked up without a rebuild.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");

export function loadFixture<T = unknown>(name: string): T {
  const path = join(fixturesDir, name);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
