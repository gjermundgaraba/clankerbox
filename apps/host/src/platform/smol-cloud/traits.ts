import type { RuntimeTraits } from "@clankerbox/host-contract/traits";
import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";

/**
 * smol cloud copies a stopped machine's disk only by exporting it, which pushes an artifact into
 * the account's registry that no shipped tool can delete, so a fork or capture of a stopped machine
 * is refused rather than leave storage behind it. Its export documents neither a body nor an answer.
 * Once smol cloud deletes a pushed artifact, or documents what export pushes and answers, a stopped
 * copy can be an export, and `captureFrom` `either`:
 * https://smolmachines.com/openapi.json (`machine_export`)
 * https://smolmachines.com/docs/guides/skills/cloud-registry.md ("What cannot be undone")
 * https://smolmachines.com/docs/cloud/api-reference.md ("export a stopped machine's disk")
 */
export const traits = (
  most: RuntimeTraits["limits"]["most"]
): RuntimeTraits => ({
  runtime: RuntimeName.make("smol-cloud"),
  images: "references",
  captureFrom: "running",
  whyRunning:
    "smol cloud has no way to copy a stopped machine's disk that doesn't leave storage in the account which nothing can delete",
  copies: "same",
  resize: { running: "grow", stopped: "grow" },
  sizes: { _tag: "free" },
  limits: { least: {}, most },
});
