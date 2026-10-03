import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { useVideoConfig } from "remotion";
import { Flip } from "./scenes/Flip";
import { Hook } from "./scenes/Hook";
import { Install } from "./scenes/Install";
import { LinkWallet } from "./scenes/LinkWallet";
import { OnChain } from "./scenes/OnChain";
import { Outro } from "./scenes/Outro";
import { Paid } from "./scenes/Paid";
import { Rewards } from "./scenes/Rewards";
import { Sync } from "./scenes/Sync";

// The full demo. Scene lengths minus the 8 transitions of 15 frames = TRACE_DEMO_FRAMES.
export const TRACE_DEMO_FRAMES = 4680 - 8 * 15;

export const TraceDemo: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <TransitionSeries>
      <TransitionSeries.Sequence name="Hook" durationInFrames={240} premountFor={fps}>
        <Hook />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 15 })} />
      <TransitionSeries.Sequence name="Flip" durationInFrames={360} premountFor={fps}>
        <Flip />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={linearTiming({ durationInFrames: 15 })} />
      <TransitionSeries.Sequence name="1 Install" durationInFrames={660} premountFor={fps}>
        <Install />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={linearTiming({ durationInFrames: 15 })} />
      <TransitionSeries.Sequence name="2 Sync" durationInFrames={420} premountFor={fps}>
        <Sync />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={linearTiming({ durationInFrames: 15 })} />
      <TransitionSeries.Sequence name="3 Link wallet" durationInFrames={840} premountFor={fps}>
        <LinkWallet />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={linearTiming({ durationInFrames: 15 })} />
      <TransitionSeries.Sequence name="4 Paid" durationInFrames={660} premountFor={fps}>
        <Paid />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 15 })} />
      <TransitionSeries.Sequence name="Rewards" durationInFrames={600} premountFor={fps}>
        <Rewards />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 15 })} />
      <TransitionSeries.Sequence name="On-chain" durationInFrames={600} premountFor={fps}>
        <OnChain />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 15 })} />
      <TransitionSeries.Sequence name="Outro" durationInFrames={300} premountFor={fps}>
        <Outro />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );
};
