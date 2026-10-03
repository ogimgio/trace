import { AbsoluteFill, useVideoConfig } from "remotion";
import { Background } from "../components/Background";
import { Callout } from "../components/Callout";
import { SceneAudio } from "../components/SceneAudio";
import { ScreenClip } from "../components/ScreenClip";
import { StepHeader } from "../components/StepHeader";
import { colors } from "../theme";

// Demo step 2: the first sync, as seen in the popup.
export const Sync: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Background />
      <SceneAudio file="voice/04-sync.mp3" />
      <StepHeader
        name="Header"
        premountFor={fps}
        step={2}
        title="Sync"
        badgeColor={colors.soft}
      />
      <ScreenClip
        name="Recording: sync"
        premountFor={fps}
        src="clips/02-sync.mp4"
        todo="Open the TRACE popup: “Syncing…” → “Active”, visits shared, last sync, next sync"
        startAt={0}
        speed={1}
      />
      <Callout
        name="Callout: first sync"
        from={1 * fps}
        premountFor={fps}
        label="First sync"
        accentColor={colors.sky}
        style={{ left: 1260, top: 220 }}
      >
        Uploads the history Chrome keeps, about 90 days
      </Callout>
      <Callout
        name="Callout: local filter"
        from={5 * fps}
        premountFor={fps}
        label="Filtered locally"
        accentColor={colors.yellow}
        style={{ left: 1260, top: 455 }}
      >
        Local and private addresses never leave the browser
      </Callout>
      <Callout
        name="Callout: background"
        from={9 * fps}
        premountFor={fps}
        label="Then automatic"
        accentColor={colors.soft}
        style={{ left: 1260, top: 690 }}
      >
        New visits sync in the background once a day
      </Callout>
    </AbsoluteFill>
  );
};
