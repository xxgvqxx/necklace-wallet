/**
 * Renders a QR code for arbitrary text as an inline SVG (one `<path>`), with a
 * configurable quiet zone. SVG is generated from the boolean module matrix, so
 * there is no <img>, no data: URL, and no canvas — nothing that could load
 * remote bytes. Colours default to a high-contrast dark-on-light code that
 * scanners read reliably even on a dark UI background.
 */

import { useMemo } from "react";
import { encodeQr } from "./qr-encode.js";

export interface QrCodeProps {
  /** The payload to encode (e.g. a bech32m address). */
  value: string;
  /** Rendered pixel size of the square (default 200). */
  size?: number;
  /** Quiet-zone width in modules (default 4, per spec). */
  quietZone?: number;
  /** Dark-module colour. */
  fg?: string;
  /** Background colour (quiet zone + light modules). */
  bg?: string;
  /** Accessible label. */
  title?: string;
}

export function QrCode({
  value,
  size = 200,
  quietZone = 4,
  fg = "#0e0f13",
  bg = "#ffffff",
  title = "QR code",
}: QrCodeProps): React.JSX.Element {
  const { path, dim } = useMemo(() => {
    const matrix = encodeQr(value);
    const n = matrix.length;
    const total = n + quietZone * 2;
    // Build a single SVG path of 1x1 rects for every dark module.
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r]![c]) {
          const x = c + quietZone;
          const y = r + quietZone;
          d += `M${x} ${y}h1v1h-1z`;
        }
      }
    }
    return { path: d, dim: total };
  }, [value, quietZone]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      role="img"
      aria-label={title}
      shapeRendering="crispEdges"
      style={{ borderRadius: 8, display: "block" }}
    >
      <rect width={dim} height={dim} fill={bg} />
      <path d={path} fill={fg} />
    </svg>
  );
}
