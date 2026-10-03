import { Composition, Folder } from "remotion";
import { Flip } from "./scenes/Flip";
import { Hook } from "./scenes/Hook";
import { Install } from "./scenes/Install";
import { LinkWallet } from "./scenes/LinkWallet";
import { OnChain } from "./scenes/OnChain";
import { Outro } from "./scenes/Outro";
import { Paid } from "./scenes/Paid";
import { Rewards } from "./scenes/Rewards";
import { Sync } from "./scenes/Sync";
import { TRACE_DEMO_FRAMES, TraceDemo } from "./TraceDemo";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TraceDemo"
        component={TraceDemo}
        durationInFrames={TRACE_DEMO_FRAMES}
        fps={30}
        width={1920}
        height={1080}
      />
      <Folder name="Scenes">
        <Composition id="Hook" component={Hook} durationInFrames={240} fps={30} width={1920} height={1080} />
        <Composition id="Flip" component={Flip} durationInFrames={360} fps={30} width={1920} height={1080} />
        <Composition id="Install" component={Install} durationInFrames={660} fps={30} width={1920} height={1080} />
        <Composition id="Sync" component={Sync} durationInFrames={420} fps={30} width={1920} height={1080} />
        <Composition id="LinkWallet" component={LinkWallet} durationInFrames={840} fps={30} width={1920} height={1080} />
        <Composition id="Paid" component={Paid} durationInFrames={660} fps={30} width={1920} height={1080} />
        <Composition id="Rewards" component={Rewards} durationInFrames={600} fps={30} width={1920} height={1080} />
        <Composition id="OnChain" component={OnChain} durationInFrames={600} fps={30} width={1920} height={1080} />
        <Composition id="Outro" component={Outro} durationInFrames={300} fps={30} width={1920} height={1080} />
      </Folder>
    </>
  );
};
