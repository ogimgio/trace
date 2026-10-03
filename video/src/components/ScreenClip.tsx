import { Video } from "@remotion/media";
import type React from "react";
import {
  Easing,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  type InteractivitySchema,
} from "remotion";
import { colors, fonts, hasStaticFile, line, shadow } from "../theme";

type ScreenClipProps = {
  readonly src: string;
  readonly todo: string;
  readonly startAt: number;
  readonly speed: number;
  readonly style?: React.CSSProperties;
};

// A screen recording in a card. Until public/<src> exists it shows what to record instead.
const ScreenClipInner: React.FC<ScreenClipProps> = ({
  src,
  todo,
  startAt,
  speed,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const recorded = hasStaticFile(src);

  return (
    <Interactive.Div
      name="Screen card"
      style={{
        position: "absolute",
        left: 100,
        top: 220,
        width: 1080,
        height: 720,
        backgroundColor: recorded ? colors.ink : colors.paper,
        border: line,
        borderRadius: 26,
        boxShadow: shadow,
        overflow: "hidden",
        opacity: interpolate(frame, [0, 0.4 * fps], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
        scale: interpolate(frame, [0, 0.8 * fps], [0.94, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
          output: "perceptual-scale",
        }),
        ...style,
      }}
    >
      {recorded ? (
        <Video
          name="Recording"
          src={staticFile(src)}
          trimBefore={Math.round(startAt * fps)}
          playbackRate={speed}
          muted
          objectFit="contain"
          premountFor={fps}
          style={{ width: "100%", height: "100%" }}
        />
      ) : (
        <div
          style={{
            height: "100%",
            padding: 70,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 28,
            fontFamily: fonts.body,
            color: colors.ink,
            backgroundImage: `repeating-linear-gradient(-45deg, ${colors.paper} 0 28px, #eef2f5 28px 56px)`,
          }}
        >
          <div
            style={{
              alignSelf: "flex-start",
              padding: "6px 18px",
              border: `3px solid ${colors.ink}`,
              borderRadius: 999,
              backgroundColor: colors.yellow,
              fontWeight: 700,
              fontSize: 24,
              letterSpacing: "0.1em",
            }}
          >
            ● SCREEN RECORDING TO ADD
          </div>
          <div
            style={{
              fontFamily: fonts.display,
              fontWeight: 700,
              fontSize: 50,
              lineHeight: 1.15,
            }}
          >
            {todo}
          </div>
          <div style={{ fontFamily: fonts.mono, fontSize: 28, color: colors.muted }}>
            public/{src}
          </div>
        </div>
      )}
    </Interactive.Div>
  );
};

const screenClipSchema = {
  src: {
    type: "asset",
    default: "",
    description: "Recording (in public/)",
  },
  todo: { type: "text-content", default: "", description: "What to record" },
  startAt: {
    type: "number",
    default: 0,
    min: 0,
    step: 0.1,
    description: "Skip the first N seconds",
    hiddenFromList: false,
  },
  speed: {
    type: "number",
    default: 1,
    min: 0.25,
    max: 4,
    step: 0.05,
    description: "Playback speed",
    hiddenFromList: false,
  },
} as const satisfies InteractivitySchema;

export const ScreenClip = Interactive.withSchema({
  Component: ScreenClipInner,
  componentName: "<ScreenClip>",
  schema: screenClipSchema,
  wrapInSequence: true,
});
