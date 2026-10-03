import { AbsoluteFill, useVideoConfig } from "remotion";
import { Background } from "../components/Background";
import { Callout } from "../components/Callout";
import { SceneAudio } from "../components/SceneAudio";
import { ScreenClip } from "../components/ScreenClip";
import { StepHeader } from "../components/StepHeader";
import { colors } from "../theme";

// Demo step 1: landing page → install → consent.
export const Install: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Background />
      <SceneAudio file="voice/03-install.mp3" />
      <StepHeader
        name="Header"
        premountFor={fps}
        step={1}
        title="Install and consent"
        badgeColor={colors.sky}
      />
      <ScreenClip
        name="Recording: install"
        premountFor={fps}
        src="clips/01-install.mp4"
        todo="trace-rewards.vercel.app → Download → Load unpacked → welcome tab → scroll the consent → “I agree, grant access” → Chrome history prompt → Allow"
        startAt={0}
        speed={1}
      />
      <Callout
        name="Callout: download"
        from={1 * fps}
        premountFor={fps}
        label="Live MVP"
        accentColor={colors.sky}
        style={{ left: 1260, top: 220 }}
      >
        Download the extension from trace-rewards.vercel.app
      </Callout>
      <Callout
        name="Callout: consent"
        from={8 * fps}
        premountFor={fps}
        label="Consent first"
        accentColor={colors.yellow}
        style={{ left: 1260, top: 455 }}
      >
        A welcome tab shows exactly what is shared
      </Callout>
      <Callout
        name="Callout: permission"
        from={15 * fps}
        premountFor={fps}
        label="Optional permission"
        accentColor={colors.soft}
        style={{ left: 1260, top: 690 }}
      >
        History access is requested only on Accept
      </Callout>
    </AbsoluteFill>
  );
};
