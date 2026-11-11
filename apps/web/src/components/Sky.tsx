/** Shared SVG defs for the line drawings (dot fill for the solver sphere, soft glow). Rendered once in the layout. */
export function SkyDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <pattern id="mb-dot" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="1.4" fill="#e4f2ee" /></pattern>
        <radialGradient id="mb-orb" cx=".42" cy=".38" r=".7">
          <stop offset="0" stopColor="#d9f1ea" stopOpacity=".45" /><stop offset=".7" stopColor="#9fc9d6" stopOpacity=".12" /><stop offset="1" stopColor="#9fc9d6" stopOpacity="0" />
        </radialGradient>
        <filter id="mb-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
    </svg>
  );
}
