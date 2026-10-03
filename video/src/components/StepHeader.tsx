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

type StepHeaderProps = {
  readonly step: number;
  readonly title: string;
  readonly badgeColor: string;
  readonly style?: React.CSSProperties;
};

// "1  Install and consent" in the top-left corner of each demo step.
const StepHeaderInner: React.FC<StepHeaderProps> = ({
  step,
  title,
  badgeColor,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <Interactive.Div
      name="Step header"
      style={{
        position: "absolute",
        left: 100,
        top: 70,
        display: "flex",
        alignItems: "center",
        gap: 28,
        opacity: interpolate(frame, [0, 0.4 * fps], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
        translate: interpolate(frame, [0, 0.7 * fps], ["0px -30px", "0px 0px"], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
        ...style,
      }}
    >
      <div
        style={{
          width: 96,
          height: 96,
          border: line,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          backgroundColor: badgeColor,
          boxShadow: `5px 5px 0 ${colors.ink}`,
          fontFamily: fonts.display,
          fontWeight: 700,
          fontSize: 52,
          color: colors.ink,
        }}
      >
        {step}
      </div>
      <div
        style={{
          fontFamily: fonts.display,
          fontWeight: 700,
          fontSize: 84,
          letterSpacing: "-0.02em",
          color: colors.ink,
        }}
      >
        {title}
      </div>
    </Interactive.Div>
  );
};

const stepHeaderSchema = {
  step: { type: "number", default: 1, min: 1, integer: true, description: "Step", hiddenFromList: false },
  title: { type: "text-content", default: "", description: "Title" },
  badgeColor: { type: "color", default: colors.sky, description: "Badge color" },
} as const satisfies InteractivitySchema;

export const StepHeader = Interactive.withSchema({
  Component: StepHeaderInner,
  componentName: "<StepHeader>",
  schema: stepHeaderSchema,
  wrapInSequence: true,
});
