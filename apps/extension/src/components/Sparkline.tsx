/**
 * Sparkline — a minimal line chart of a numeric series rendered as one SVG
 * polyline. Stretches to fill its container (preserveAspectRatio="none") with a
 * non-scaling stroke. Decorative (aria-hidden); renders null with < 2 points.
 * Colour is applied via CSS `color` so theme CSS-variable tokens resolve.
 */

export interface SparklineProps {
  values: number[];
  /** Line colour (a theme token / CSS color). */
  color: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}

export function Sparkline({
  values,
  color,
  strokeWidth = 2,
  style,
}: SparklineProps): React.JSX.Element | null {
  if (values.length < 2) return null;
  const W = 100;
  const H = 32;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = H - ((v - min) / range) * H;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden
      style={{ width: "100%", height: "100%", display: "block", color, ...style }}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
