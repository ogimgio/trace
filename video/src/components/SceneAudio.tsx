import { Audio } from "@remotion/media";
import { staticFile, useVideoConfig } from "remotion";
import { hasStaticFile } from "../theme";

// Plays public/<file> if it exists. Drop one voiceover file per scene into public/voice/.
export const SceneAudio: React.FC<{ readonly file: string }> = ({ file }) => {
  const { fps } = useVideoConfig();
  if (!hasStaticFile(file)) return null;
  return <Audio name="Voiceover" src={staticFile(file)} premountFor={fps} />;
};
