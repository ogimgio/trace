import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { appear, pop } from "../anim";
import { Background } from "../components/Background";
import { LogoMark } from "../components/Logo";
import { SceneAudio } from "../components/SceneAudio";
import { colors, fonts, line } from "../theme";

// 0:00 – the problem in one sentence, then the logo.
export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Background dark />
      <SceneAudio file="voice/01-hook.mp3" />

      <Interactive.Div
        name="Problem line"
        durationInFrames={4 * fps}
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 160px",
          fontFamily: fonts.display,
          fontWeight: 700,
          fontSize: 110,
          lineHeight: 1.05,
          letterSpacing: "-0.03em",
          color: colors.paper,
          opacity: interpolate(frame, [3.5 * fps, 4 * fps], [1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        <div style={appear(frame, 5)}>Your browsing history</div>
        <div style={appear(frame, 15)}>is already collected</div>
        <div style={appear(frame, 25)}>
          and <span style={{ color: colors.sky }}>sold by trackers.</span>
        </div>
        <div
          style={{
            ...appear(frame, 1.8 * fps),
            marginTop: 40,
            fontFamily: fonts.body,
            fontWeight: 500,
            fontSize: 56,
            letterSpacing: 0,
            color: colors.nightText,
          }}
        >
          You never see a cent of it.
        </div>
      </Interactive.Div>

      <Interactive.Div
        name="Logo reveal"
        from={4 * fps}
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 34,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 36,
            ...pop(frame, 4 * fps),
          }}
        >
          <LogoMark size={200} />
          <div
            style={{
              fontFamily: fonts.display,
              fontWeight: 700,
              fontSize: 190,
              letterSpacing: "0.14em",
              color: colors.paper,
            }}
          >
            TRACE
          </div>
        </div>
        <div
          style={{
            ...appear(frame, 4.6 * fps),
            fontFamily: fonts.body,
            fontWeight: 500,
            fontSize: 56,
            color: colors.paper,
          }}
        >
          Get paid for the browsing data{" "}
          <span
            style={{
              backgroundColor: colors.sky,
              color: colors.ink,
              padding: "0 12px",
              borderRadius: 12,
            }}
          >
            you choose
          </span>{" "}
          to share.
        </div>
        <div
          style={{
            ...appear(frame, 5.3 * fps),
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginTop: 10,
            padding: "10px 26px",
            border: line,
            borderColor: colors.paper,
            borderRadius: 999,
            fontFamily: fonts.body,
            fontWeight: 700,
            fontSize: 30,
            color: colors.paper,
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              backgroundColor: colors.sky,
              scale: interpolate(frame % fps, [0, fps / 2, fps], [1, 1.5, 1], {
                easing: Easing.inOut(Easing.ease),
              }),
            }}
          />
          Chrome extension · Live on Solana Devnet
        </div>
      </Interactive.Div>
    </AbsoluteFill>
  );
};
