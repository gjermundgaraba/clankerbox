export const traits = {
  runtime: "smolvm",
  images: "references",
  checkpoint: "ram",
  captureFrom: "running",
  pause: "saves",
  copies: "grow",
  resize: { running: "grow", stopped: "any" },
  sizes: { _tag: "free" },
  stopsOnItsOwn: false,
};
