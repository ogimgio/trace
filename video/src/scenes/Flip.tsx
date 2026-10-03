import {
  AbsoluteFill,
  Interactive,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { appear } from "../anim";
import { Background } from "../components/Background";
import { SceneAudio } from "../components/SceneAudio";
import { colors, fonts, line, shadow } from "../theme";

const Card: React.FC<{
  readonly num: string;
  readonly color: string;
  readonly title: string;
  readonly text: string;
  readonly style: React.CSSProperties;
}> = ({ num, color, title, text, style }) => (
  <div
    style={{
      flex: 1,
      padding: 44,
      backgroundColor: colors.paper,
      border: line,
      borderRadius: 26,
      boxShadow: shadow,
      ...style,
    }}
  >
    <div
      style={{
        width: 84,
        height: 84,
        marginBottom: 30,
        border: line,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        backgroundColor: color,
        fontFamily: fonts.display,
        fontWeight: 700,
        fontSize: 44,
      }}
    >
      {num}
    </div>
    <div
      style={{
        fontFamily: fonts.display,
        fontWeight: 700,
        fontSize: 54,
        lineHeight: 1.1,
        marginBottom: 18,
      }}
    >
      {title}
    </div>
    <div style={{ fontSize: 36, lineHeight: 1.35, color: colors.inkSoft }}>
      {text}
    </div>
  </div>
);

// 0:08 – what TRACE is: consent, local filtering, paid on Solana.
export const Flip: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ fontFamily: fonts.body, color: colors.ink }}>
      <Background />
      <SceneAudio file="voice/02-flip.mp3" />

      <Interactive.Div
        name="Title"
        style={{
          position: "absolute",
          left: 120,
          top: 110,
          right: 120,
          ...appear(frame, 0),
        }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: 30,
            letterSpacing: "0.12em",
            color: colors.skyDeep,
            marginBottom: 14,
          }}
        >
          TRACE FLIPS IT
        </div>
        <div
          style={{
            fontFamily: fonts.display,
            fontWeight: 700,
            fontSize: 96,
            lineHeight: 1.02,
            letterSpacing: "-0.03em",
          }}
        >
          Share your history on your terms.
          <br />
          Get paid for it in tokens.
        </div>
      </Interactive.Div>

      <Interactive.Div
        name="Cards"
        style={{
          position: "absolute",
          left: 120,
          right: 120,
          top: 470,
          display: "flex",
          gap: 44,
        }}
      >
        <Card
          num="1"
          color={colors.sky}
          title="Explicit consent"
          text="Nothing leaves the browser until you click Accept. Stop any time."
          style={appear(frame, 1.5 * fps, 60)}
        />
        <Card
          num="2"
          color={colors.soft}
          title="Filtered locally"
          text="Local files, localhost and private networks are never uploaded."
          style={appear(frame, 3 * fps, 60)}
        />
        <Card
          num="3"
          color={colors.yellow}
          title="Paid on Solana"
          text="TRACE tokens, sent straight to your Phantom wallet."
          style={appear(frame, 4.5 * fps, 60)}
        />
      </Interactive.Div>
    </AbsoluteFill>
  );
};
