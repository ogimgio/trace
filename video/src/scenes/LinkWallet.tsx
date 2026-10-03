import { AbsoluteFill, useVideoConfig } from "remotion";
import { Background } from "../components/Background";
import { Callout } from "../components/Callout";
import { SceneAudio } from "../components/SceneAudio";
import { ScreenClip } from "../components/ScreenClip";
import { StepHeader } from "../components/StepHeader";
import { colors } from "../theme";

// Demo step 3: device check + Phantom signature on the signing page.
export const LinkWallet: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Background />
      <SceneAudio file="voice/05-link.mp3" />
      <StepHeader
        name="Header"
        premountFor={fps}
        step={3}
        title="Link your wallet"
        badgeColor={colors.yellow}
      />
      <ScreenClip
        name="Recording: link"
        premountFor={fps}
        src="clips/03-link.mp4"
        todo="Popup → “Link with Phantom” → signing page opens → Phantom: sign the message → wallet linked"
        startAt={0}
        speed={1}
      />
      <Callout
        name="Callout: device check"
        from={2 * fps}
        premountFor={fps}
        label="Device check"
        accentColor={colors.yellow}
        style={{ left: 1260, top: 220 }}
      >
        Fingerprint keeps out bots, VMs and wallet farms
      </Callout>
      <Callout
        name="Callout: sign"
        from={10 * fps}
        premountFor={fps}
        label="Phantom signMessage"
        accentColor={colors.sky}
        style={{ left: 1260, top: 455 }}
      >
        Free, no transaction: it only proves the wallet is yours
      </Callout>
      <Callout
        name="Callout: verify"
        from={18 * fps}
        premountFor={fps}
        label="Verified server-side"
        accentColor={colors.soft}
        style={{ left: 1260, top: 690 }}
      >
        Ed25519 signature checked against the wallet's public key
      </Callout>
    </AbsoluteFill>
  );
};
