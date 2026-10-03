import { Easing, interpolate } from "remotion";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// Fade + slide up, starting at `start` (frames). Used for staggered list items.
export const appear = (frame: number, start: number, distance = 40) => ({
  opacity: interpolate(frame, [start, start + 10], [0, 1], clamp),
  translate: interpolate(
    frame,
    [start, start + 20],
    [`0px ${distance}px`, "0px 0px"],
    { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) },
  ),
});

// Pop in with a slight overshoot.
export const pop = (frame: number, start: number) => ({
  opacity: interpolate(frame, [start, start + 6], [0, 1], clamp),
  scale: interpolate(frame, [start, start + 18], [0.6, 1], {
    ...clamp,
    easing: Easing.bezier(0.34, 1.56, 0.64, 1),
  }),
});

// Counts from 0 to `to` between two frames.
export const countUp = (frame: number, start: number, end: number, to: number) =>
  Math.round(
    interpolate(frame, [start, end], [0, to], {
      ...clamp,
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    }),
  );
