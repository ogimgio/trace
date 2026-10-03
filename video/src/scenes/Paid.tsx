import { AbsoluteFill, useVideoConfig } from "remotion";
import { Background } from "../components/Background";
import { Callout } from "../components/Callout";
import { SceneAudio } from "../components/SceneAudio";
import { ScreenClip } from "../components/ScreenClip";
import { StepHeader } from "../components/StepHeader";
import { colors } from "../theme";

// Demo step 4: welcome bonus in the popup, in Phantom and on the explorer.
export const Paid: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Background />
      <SceneAudio file="voice/06-paid.mp3" />
      <StepHeader
        name="Header"
        premountFor={fps}
        step={4}
        title="Get paid"
        badgeColor={colors.sky}
      />
      <ScreenClip
        name="Recording: paid"
        premountFor={fps}
        src="clips/04-paid.mp4"
        todo="Popup: “500 TRACE received” + this week's points → Phantom shows 500 TRACE → click “sent ↗” next to the welcome bonus → transaction on Solana Explorer (Devnet)"
        startAt={0}
        speed={1}
      />
      <Callout
        name="Callout: bonus"
        from={1 * fps}
        premountFor={fps}
        label="Welcome bonus"
        accentColor={colors.yellow}
        style={{ left: 1260, top: 220 }}
      >
        500 TRACE, seconds after linking
      </Callout>
      <Callout
        name="Callout: fees"
        from={7 * fps}
        premountFor={fps}
        label="No SOL needed"
        accentColor={colors.sky}
        style={{ left: 1260, top: 455 }}
      >
        The server pays the fees and creates your token account
      </Callout>
      <Callout
        name="Callout: explorer"
        from={13 * fps}
        premountFor={fps}
        label="On-chain"
        accentColor={colors.soft}
        style={{ left: 1260, top: 690 }}
      >
        Every payout is a public transaction you can verify
      </Callout>
    </AbsoluteFill>
  );
};
