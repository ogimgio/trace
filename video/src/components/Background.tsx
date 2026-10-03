import { AbsoluteFill } from "remotion";
import { colors } from "../theme";

export const Background: React.FC<{ readonly dark?: boolean }> = ({ dark }) => {
  const dot = dark ? "#262a38" : "#cfd9df";
  return (
    <AbsoluteFill
      style={{
        backgroundColor: dark ? colors.ink : colors.sage,
        backgroundImage: `radial-gradient(${dot} 3px, transparent 3px)`,
        backgroundSize: "48px 48px",
      }}
    />
  );
};
