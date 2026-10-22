/**
 * Persists a run's `assign_slug` outputs the way the harness does, for tests
 * that write a turn's artifacts by hand.
 */

import { join } from "@std/path";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import {
  createToolOutputId,
  createToolResultRef,
} from "../../src/contracts/tool-result.ts";

/**
 * Writes each `assign_slug` result in `transcript` that carries a URL whole
 * under `<runRoot>/tool-outputs/`, and returns the transcript the model read:
 * the same messages, each such result without its URL and with a result
 * reference naming the persisted output.
 */
export const persistAssignSlugOutputs = async (
  runRoot: string,
  runId: string,
  transcript: readonly HarnessTranscriptMessage[],
): Promise<HarnessTranscriptMessage[]> => {
  await Deno.mkdir(join(runRoot, "tool-outputs"), { recursive: true });
  return await Promise.all(transcript.map(async (message, index) => {
    if (message.role !== "tool" || message.toolName !== "assign_slug") {
      return message;
    }
    let value: unknown;
    try {
      value = JSON.parse(message.content);
    } catch {
      return message;
    }
    if (!isObjectNotArray(value) || typeof value.url !== "string") {
      return message;
    }
    const artifactPath = join(
      runRoot,
      "tool-outputs",
      `${index}-assign_slug.json`,
    );
    await Deno.writeTextFile(artifactPath, JSON.stringify(value));
    const { url: _url, ...shown } = value;
    return {
      ...message,
      content: JSON.stringify(shown),
      resultRef: createToolResultRef(
        createToolOutputId(runId, "assign_slug", index),
        "assign_slug",
        runId,
        artifactPath,
      ),
    };
  }));
};
