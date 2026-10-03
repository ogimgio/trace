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
import { colors, fonts } from "../theme";

const MINT = "Gveaq1FkXYNY8CXLBEkdHwgfwzpFrBRr7vTWfJTCQFxc";

const Fact: React.FC<{
  readonly num: string;
  readonly title: string;
  readonly text: string;
  readonly style: React.CSSProperties;
}> = ({ num, title, text, style }) => (
  <div style={{ display: "flex", gap: 26, alignItems: "flex-start", ...style }}>
    <div
      style={{
        flex: "none",
        width: 64,
        height: 64,
        borderRadius: 16,
        border: `3px solid ${colors.sky}`,
        display: "grid",
        placeItems: "center",
        fontFamily: fonts.display,
        fontWeight: 700,
        fontSize: 32,
        color: colors.sky,
      }}
    >
      {num}
    </div>
    <div>
      <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 40, color: colors.paper }}>
        {title}
      </div>
      <div style={{ fontSize: 30, lineHeight: 1.3, color: colors.nightText, marginTop: 4 }}>{text}</div>
    </div>
  </div>
);

// The Solana integration: Token-2022, fixed supply, payouts, signature-based linking.
export const OnChain: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ fontFamily: fonts.body }}>
      <Background dark />
      <SceneAudio file="voice/08-onchain.mp3" />

      <Interactive.Div
        name="Title"
        style={{ position: "absolute", left: 120, top: 100, right: 120, ...appear(frame, 0) }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: 30,
            letterSpacing: "0.12em",
            color: colors.sky,
            marginBottom: 14,
          }}
        >
          BUILT ON SOLANA
        </div>
        <div
          style={{
            fontFamily: fonts.display,
            fontWeight: 700,
            fontSize: 84,
            lineHeight: 1.02,
            letterSpacing: "-0.03em",
            color: colors.paper,
          }}
        >
          Standard programs. No custom contract.
        </div>
      </Interactive.Div>

      <Interactive.Div
        name="Token card"
        style={{
          position: "absolute",
          left: 120,
          top: 340,
          width: 800,
          height: 600,
          padding: 44,
          backgroundColor: colors.night,
          border: `4px solid ${colors.nightLine}`,
          borderRadius: 26,
          boxShadow: `10px 10px 0 ${colors.sky}`,
          color: colors.paper,
          ...appear(frame, 0.5 * fps, 60),
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <div
            style={{
              width: 84,
              height: 84,
              borderRadius: "50%",
              backgroundColor: colors.ink,
              border: `3px solid ${colors.sky}`,
              display: "grid",
              placeItems: "center",
            }}
          >
            <LogoMark size={54} />
          </div>
          <div>
            <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 48 }}>TRACE</div>
            <div style={{ fontSize: 28, color: colors.nightText }}>SPL Token-2022 · 6 decimals</div>
          </div>
        </div>
        <div style={{ marginTop: 34, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 28, color: colors.nightText, letterSpacing: "0.08em" }}>FIXED SUPPLY</div>
          <div
            style={{
              padding: "8px 18px",
              border: `4px solid ${colors.yellow}`,
              borderRadius: 12,
              color: colors.yellow,
              fontWeight: 700,
              fontSize: 24,
              letterSpacing: "0.08em",
              rotate: "-4deg",
              ...pop(frame, 4 * fps),
            }}
          >
            MINT AUTHORITY REVOKED
          </div>
        </div>
        <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 88, color: colors.sky }}>
          1,000,000,000
        </div>
        <div
          style={{
            display: "flex",
            height: 70,
            marginTop: 20,
            border: `3px solid ${colors.paper}`,
            borderRadius: 14,
            overflow: "hidden",
            fontFamily: fonts.display,
            fontWeight: 700,
            fontSize: 28,
            color: colors.ink,
          }}
        >
          <div
            style={{
              width: `${interpolate(frame, [2 * fps, 3 * fps], [0, 50], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              })}%`,
              backgroundColor: colors.sky,
              display: "grid",
              placeItems: "center",
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            50% rewards pool
          </div>
          <div
            style={{
              flex: 1,
              backgroundColor: colors.soft,
              borderLeft: `3px solid ${colors.paper}`,
              display: "grid",
              placeItems: "center",
              whiteSpace: "nowrap",
              opacity: interpolate(frame, [2.6 * fps, 3.2 * fps], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
            }}
          >
            50% reserve
          </div>
        </div>
        <div style={{ marginTop: 30, fontFamily: fonts.mono, fontSize: 22, color: colors.nightText }}>
          mint {MINT}
        </div>
      </Interactive.Div>

      <Interactive.Div
        name="Facts"
        style={{
          position: "absolute",
          left: 1000,
          right: 120,
          top: 350,
          display: "flex",
          flexDirection: "column",
          gap: 44,
        }}
      >
        <Fact
          num="1"
          title="On-chain metadata"
          text="Name, symbol and logo via Token-2022 extensions"
          style={appear(frame, 5.5 * fps)}
        />
        <Fact
          num="2"
          title="TransferChecked payouts"
          text="From the rewards pool; the token account is created in the same tx"
          style={appear(frame, 8 * fps)}
        />
        <Fact
          num="3"
          title="Gasless for users"
          text="The server pays all fees; users need no SOL"
          style={appear(frame, 10.5 * fps)}
        />
        <Fact
          num="4"
          title="Signature-based linking"
          text="Phantom signMessage, verified as Ed25519"
          style={appear(frame, 13 * fps)}
        />
      </Interactive.Div>
    </AbsoluteFill>
  );
};
