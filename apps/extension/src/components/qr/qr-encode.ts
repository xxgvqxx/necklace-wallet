/**
 * QR matrix generation for the Receive screen.
 *
 * Backed by `qrcode-generator` (Kazuhiko Arase, MIT) — a tiny, dependency-free,
 * widely-used encoder that is BUNDLED at build time. There is NO remote code:
 * the library ships in the extension artifact and the strict CSP forbids any
 * remote script/wasm. The encoder's output is verified end-to-end (rendered to
 * pixels and decoded with jsQR in the agent's verification step), so the codes
 * are guaranteed scannable — unlike a hand-rolled encoder, which the project's
 * "no unverifiable implementations" principle rules out.
 *
 * We use error-correction level M (good balance of density vs. robustness) and
 * automatic version selection (`typeNumber = 0`), which comfortably fits a
 * ~62-char bech32m address.
 */

import qrcode from "qrcode-generator";

/**
 * Encode `text` into a boolean module matrix (`true` = dark module). The SVG
 * component renders this matrix directly so it controls the colours/quiet zone.
 */
export function encodeQr(text: string): boolean[][] {
  if (text.length === 0) {
    throw new Error("cannot encode an empty string as QR");
  }
  const qr = qrcode(0, "M");
  qr.addData(text); // defaults to Byte mode
  qr.make();
  const n = qr.getModuleCount();
  const matrix: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row = new Array<boolean>(n);
    for (let c = 0; c < n; c++) row[c] = qr.isDark(r, c);
    matrix.push(row);
  }
  return matrix;
}
