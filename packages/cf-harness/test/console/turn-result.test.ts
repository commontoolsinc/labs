/**
 * The console's completed-turn projection from durable model-facing run
 * artifacts.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { readConsoleTurnResult } from "../../console/turn-result.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";

const writeTranscript = async (
  artifactRoot: string,
  turnId: string,
  transcript: readonly HarnessTranscriptMessage[],
): Promise<void> => {
  const runRoot = join(artifactRoot, turnId);
  await Deno.mkdir(runRoot, { recursive: true });
  await Deno.writeTextFile(
    join(runRoot, "transcript.json"),
    JSON.stringify(transcript),
  );
};

describe("console/turn-result", () => {
  it("returns successful `assign_slug` values exactly as the model received them", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      await writeTranscript(artifactRoot, "turn-with-piece", [
        { role: "user", content: "build a reading list" },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "assign_slug",
          content: JSON.stringify({
            outputId: "run:assign_slug:1",
            status: "ok",
            slug: "reading-list",
            url: "http://localhost:8000/console-test/reading-list",
          }),
        },
        { role: "assistant", content: "Your reading list is ready." },
      ]);

      await expect(readConsoleTurnResult({
        artifactRoot,
        turnId: "turn-with-piece",
        spaceName: "console-test",
      })).resolves.toEqual({
        pieces: [{
          slug: "reading-list",
          url: "http://localhost:8000/console-test/reading-list",
        }],
        spaceName: "console-test",
        finalText: "Your reading list is ready.",
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("returns `pieces: []` when the run assigned no slug", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      await writeTranscript(artifactRoot, "turn-without-piece", [
        { role: "user", content: "calculate the total" },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "run_pattern",
          content: JSON.stringify({
            outputId: "run:run_pattern:1",
            status: "ok",
          }),
        },
        { role: "assistant", content: "The total is 42." },
      ]);

      await expect(readConsoleTurnResult({
        artifactRoot,
        turnId: "turn-without-piece",
        spaceName: "console-test",
      })).resolves.toEqual({
        pieces: [],
        spaceName: "console-test",
        finalText: "The total is 42.",
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });
});
