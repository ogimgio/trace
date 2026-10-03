import { loadFont } from "@remotion/fonts";
import { getStaticFiles, staticFile } from "remotion";

// Same palette and fonts as the landing page and the extension.
export const colors = {
  sage: "#e5ecf0",
  paper: "#f8fafb",
  ink: "#0e0f14",
  inkSoft: "#3b3f4a",
  muted: "#5d6270",
  sky: "#5ec8f2",
  skyDeep: "#1580b5",
  soft: "#cdeefb",
  yellow: "#ffd66b",
  night: "#161822",
  nightLine: "#3a3f52",
  nightText: "#b8bcc8",
};

export const fonts = {
  body: "'DM Sans', system-ui, sans-serif",
  display: "'Space Grotesk', system-ui, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

loadFont({
  family: "DM Sans",
  url: staticFile("fonts/DMSans.woff2"),
  weight: "400 700",
});
loadFont({
  family: "Space Grotesk",
  url: staticFile("fonts/SpaceGrotesk-700.woff2"),
  weight: "700",
});

export const line = `4px solid ${colors.ink}`;
export const shadow = `10px 10px 0 ${colors.ink}`;

// Screen recordings and voiceover files are optional: a scene shows a placeholder until the file exists in public/.
export const hasStaticFile = (name: string) =>
  getStaticFiles().some((f) => f.name === name);
