import {
  AbsoluteFill,
  Interactive,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { appear, pop } from "../anim";
import { Background } from "../components/Background";
import { LogoMark } from "../components/Logo";
import { SceneAudio } from "../components/SceneAudio";
import { colors, fonts, line, shadow } from "../theme";

// Where to try it.
export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ fontFamily: fonts.body, color: colors.ink }}>
      <Background />
      <SceneAudio file="voice/09-outro.mp3" />

      <Interactive.Div
        name="Final card"
        style={{
          position: "absolute",
          left: 200,
          right: 200,
          top: 170,
          bottom: 170,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 26,
          backgroundColor: colors.sky,
          border: line,
          borderRadius: 34,
          boxShadow: shadow,
          ...pop(frame, 0),
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <LogoMark size={110} color={colors.ink} />
          <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 100, letterSpacing: "0.14em" }}>
            TRACE
          </div>
        </div>
        <div style={{ fontSize: 46, fontWeight: 500, ...appear(frame, 0.5 * fps) }}>
          Your history is data. Get paid for it.
        </div>
        <div
          style={{
            marginTop: 20,
            padding: "18px 40px",
            backgroundColor: colors.ink,
            color: colors.paper,
            borderRadius: 999,
            fontFamily: fonts.display,
            fontWeight: 700,
            fontSize: 60,
            ...appear(frame, 1.2 * fps),
          }}
        >
          trace-rewards.vercel.app
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 34, ...appear(frame, 1.8 * fps) }}>
          github.com/ogimgio/trace
        </div>
        <div style={{ fontWeight: 700, fontSize: 28, letterSpacing: "0.1em", ...appear(frame, 2.4 * fps) }}>
          LIVE ON SOLANA DEVNET
        </div>
      </Interactive.Div>
    </AbsoluteFill>
  );
};
