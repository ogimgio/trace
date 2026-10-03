import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { appear, countUp, pop } from "../anim";
import { Background } from "../components/Background";
import { SceneAudio } from "../components/SceneAudio";
import { colors, fonts, line, shadow } from "../theme";

const WEEKS = 52;

const card: React.CSSProperties = {
  position: "absolute",
  top: 340,
  height: 540,
  padding: 44,
  backgroundColor: colors.paper,
  border: line,
  borderRadius: 26,
  boxShadow: shadow,
};

const Row: React.FC<{
  readonly label: string;
  readonly value: string;
  readonly style: React.CSSProperties;
}> = ({ label, value, style }) => (
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      fontSize: 40,
      ...style,
    }}
  >
    <span style={{ color: colors.inkSoft }}>{label}</span>
    <span style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 48 }}>
      {value}
    </span>
  </div>
);

const Chip: React.FC<{ readonly children: string; readonly style: React.CSSProperties }> = ({
  children,
  style,
}) => (
  <div
    style={{
      padding: "12px 26px",
      border: `3px solid ${colors.ink}`,
      borderRadius: 999,
      backgroundColor: colors.paper,
      boxShadow: `0 5px 0 ${colors.ink}`,
      fontWeight: 700,
      fontSize: 30,
      ...style,
    }}
  >
    {children}
  </div>
);

// How points turn into TRACE: the weekly formula and the shrinking budget.
export const Rewards: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const pages = countUp(frame, 1.5 * fps, 3 * fps, 600);
  const days = countUp(frame, 3 * fps, 4.5 * fps, 5);
  const points = countUp(frame, 5 * fps, 6.5 * fps, 1100);

  return (
    <AbsoluteFill style={{ fontFamily: fonts.body, color: colors.ink }}>
      <Background />
      <SceneAudio file="voice/07-rewards.mp3" />

      <Interactive.Div
        name="Title"
        style={{ position: "absolute", left: 120, top: 100, right: 120, ...appear(frame, 0) }}
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
          WEEKLY REWARDS
        </div>
        <div
          style={{
            fontFamily: fonts.display,
            fontWeight: 700,
            fontSize: 84,
            lineHeight: 1.02,
            letterSpacing: "-0.03em",
          }}
        >
          Points become TRACE, every week.
        </div>
      </Interactive.Div>

      <Interactive.Div
        name="Points card"
        style={{ ...card, left: 120, width: 800, ...appear(frame, 0.5 * fps, 60) }}
      >
        <div style={{ fontFamily: fonts.mono, fontSize: 26, color: colors.muted, marginBottom: 34 }}>
          min(unique pages, 1000) + 100 × active days
        </div>
        <Row label="Unique pages" value={`${pages}`} style={appear(frame, 1.5 * fps)} />
        <Row
          label="Active days (≥ 5 visits)"
          value={`${days} × 100`}
          style={{ ...appear(frame, 3 * fps), marginTop: 22 }}
        />
        <div style={{ borderTop: line, margin: "34px 0 28px" }} />
        <Row label="Points this week" value={`${points.toLocaleString("en-US")}`} style={appear(frame, 5 * fps)} />
        <div
          style={{
            marginTop: 30,
            padding: "18px 26px",
            border: line,
            borderRadius: 16,
            backgroundColor: colors.sky,
            fontWeight: 700,
            fontSize: 38,
            ...pop(frame, 7 * fps),
          }}
        >
          → up to 1,100 TRACE (1 per point)
        </div>
      </Interactive.Div>

      <Interactive.Div
        name="Budget card"
        style={{ ...card, left: 980, width: 820, ...appear(frame, 8 * fps, 60) }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 44 }}>
            Weekly budget
          </div>
          <div style={{ fontWeight: 700, fontSize: 32, color: colors.skyDeep }}>−1% every week</div>
        </div>
        <div style={{ fontSize: 30, color: colors.inkSoft, marginTop: 6 }}>
          Starts at 5M TRACE, split by points among everyone
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 4,
            height: 250,
            marginTop: 30,
            borderBottom: line,
          }}
        >
          {Array.from({ length: WEEKS }, (_, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${100 * 0.99 ** i}%`,
                backgroundColor: i === 0 ? colors.skyDeep : colors.sky,
                border: `2px solid ${colors.ink}`,
                borderBottom: 0,
                borderRadius: "4px 4px 0 0",
                transformOrigin: "bottom",
                scale: `1 ${interpolate(frame, [9 * fps + i, 9 * fps + i + 12], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.bezier(0.16, 1, 0.3, 1),
                })}`,
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: colors.muted, marginTop: 8 }}>
          <span>Week 1</span>
          <span>Week 52</span>
        </div>
        <div style={{ marginTop: 18, fontWeight: 700, fontSize: 34, ...appear(frame, 11.5 * fps) }}>
          All weeks add up to exactly the 500M pool.
        </div>
      </Interactive.Div>

      <Interactive.Div
        name="Rule chips"
        style={{
          position: "absolute",
          left: 120,
          right: 120,
          top: 930,
          display: "flex",
          gap: 22,
          justifyContent: "center",
        }}
      >
        <Chip style={appear(frame, 13.5 * fps)}>Each visit is paid once</Chip>
        <Chip style={appear(frame, 14.5 * fps)}>Settled after an 8-day grace period</Chip>
        <Chip style={appear(frame, 15.5 * fps)}>Paid automatically, every week</Chip>
      </Interactive.Div>
    </AbsoluteFill>
  );
};
