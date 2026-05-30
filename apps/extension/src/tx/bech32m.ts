/**
 * Minimal, dependency-free bech32m (BIP-350) decoder for client-side-first
 * ADDRESS VALIDATION ONLY.
 *
 * This is NOT cryptography — it is the standard BIP-173/BIP-350 checksum/charset
 * parse used to validate that a user-pasted recipient address is well-formed,
 * has the right HRP for the active network, and carries a valid witness program
 * (address validation is client-side first). The canonical
 * encoder/decoder for signing lives in `@necklace/wallet-core` (pinned to the
 * repo's real KATs); this local copy lets the UI reject bad input before any
 * network call and without pulling a crypto dep into the UI layer.
 *
 * Pearl is Taproot-only: witness v1 (P2TR) is the MVP spend path, v2 (P2MR) is
 * recognised but out of scope, and legacy bech32 v0 is explicitly REJECTED
 * (derived-address.json invalid cases). Witness program is always 32 bytes.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** bech32m constant (BIP-350); bech32 (v0) uses 1, which Pearl rejects. */
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i]!;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** Decode a raw bech32m string into hrp + 5-bit data words, verifying the m-checksum. */
function decodeRaw(addr: string): { hrp: string; words: number[] } | null {
  // Reject mixed case (BIP-173): the whole string must be one case.
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  const lower = addr.toLowerCase();
  if (lower.length < 8 || lower.length > 90) return null;

  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return null;

  const hrp = lower.slice(0, sep);
  const dataPart = lower.slice(sep + 1);

  const data: number[] = [];
  for (const ch of dataPart) {
    const idx = CHARSET.indexOf(ch);
    if (idx === -1) return null;
    data.push(idx);
  }

  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST) return null;

  // Strip the 6-word checksum.
  return { hrp, words: data.slice(0, -6) };
}

/** Convert from `fromBits`-bit groups to `toBits`-bit groups (BIP-173 convertbits). */
function convertBits(
  data: number[],
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

export interface DecodedSegwit {
  hrp: string;
  witnessVersion: number;
  /** Witness program bytes, hex-encoded. */
  programHex: string;
  programLength: number;
}

/**
 * Decode a SegWit/Taproot address (witness program + version) using bech32m.
 * Returns null for anything malformed or for a v0 (legacy bech32) address —
 * Pearl rejects v0 outright. Does NOT enforce HRP/network; the caller does that.
 */
export function decodeSegwitAddress(addr: string): DecodedSegwit | null {
  const raw = decodeRaw(addr);
  if (!raw) return null;
  const { hrp, words } = raw;
  if (words.length === 0) return null;

  const witnessVersion = words[0]!;
  // Pearl: witness version 1 (P2TR) or 2 (P2MR) only; never v0.
  if (witnessVersion < 1 || witnessVersion > 16) return null;

  const program = convertBits(words.slice(1), 5, 8, false);
  if (!program) return null;
  // BIP-141 length bounds; Pearl programs are always 32 bytes.
  if (program.length < 2 || program.length > 40) return null;

  const programHex = program
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    hrp,
    witnessVersion,
    programHex,
    programLength: program.length,
  };
}
