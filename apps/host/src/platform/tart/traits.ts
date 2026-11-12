export const traits = {
  runtime: "tart",
  images: "named",
  checkpoint: "disk",
  captureFrom: "stopped",
  pause: "saves",
  copies: "any",
  resize: { running: "none", stopped: "any" },
  sizes: { _tag: "free" },
  stopsOnItsOwn: false,
};
