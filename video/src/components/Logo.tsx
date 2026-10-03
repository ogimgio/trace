import { colors } from "../theme";

// The TRACE mark from brand/logo.svg, inline so it can be recoloured.
export const LogoMark: React.FC<{
  readonly size: number;
  readonly color?: string;
}> = ({ size, color = colors.sky }) => (
  <svg viewBox="44 72 420 420" width={size} height={size}>
    <g fill={color}>
      <circle cx="84" cy="168" r="20" />
      <circle cx="148" cy="168" r="26" />
      <path d="M222 136h196a32 32 0 0 1 0 64h-66v178a32 32 0 0 1-64 0V200h-66a32 32 0 0 1 0-64z" />
    </g>
  </svg>
);
