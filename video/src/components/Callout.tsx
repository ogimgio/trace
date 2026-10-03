import type React from "react";
import {
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  type InteractivitySchema,
} from "remotion";
import { colors, fonts, line } from "../theme";

type CalloutProps = {
  readonly children: string;
  readonly label: string;
  readonly accentColor: string;
  readonly style?: React.CSSProperties;
};

// A card next to the screen recording that names what the viewer is looking at.
const CalloutInner: React.FC<CalloutProps> = ({
  children,
  label,
  accentColor,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <Interactive.Div
      name="Callout card"
      style={{
        position: "absolute",
        width: 560,
        padding: "22px 28px",
        backgroundColor: colors.paper,
        border: line,
        borderRadius: 22,
        boxShadow: `8px 8px 0 ${colors.ink}`,
        fontFamily: fonts.body,
        color: colors.ink,
        opacity: interpolate(frame, [0, 0.3 * fps], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
        translate: interpolate(frame, [0, 0.6 * fps], ["60px 0px", "0px 0px"], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
        ...style,
      }}
    >
      <div
        style={{
          display: "inline-block",
          padding: "4px 14px",
          marginBottom: 14,
          border: `3px solid ${colors.ink}`,
          borderRadius: 999,
          backgroundColor: accentColor,
          fontWeight: 700,
          fontSize: 22,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 34, lineHeight: 1.25, fontWeight: 500 }}>
        {children}
      </div>
    </Interactive.Div>
  );
};

const calloutSchema = {
  children: { type: "text-content", default: "", description: "Text" },
  label: { type: "text-content", default: "", description: "Label" },
  accentColor: {
    type: "color",
    default: colors.sky,
    description: "Label color",
  },
} as const satisfies InteractivitySchema;

export const Callout = Interactive.withSchema({
  Component: CalloutInner,
  componentName: "<Callout>",
  schema: calloutSchema,
  wrapInSequence: true,
});
