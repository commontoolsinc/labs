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
  firstGeneratedIndex = 1,
): Promise<void> => {
  const runRoot = join(artifactRoot, turnId);
  await Deno.mkdir(runRoot, { recursive: true });
  await Deno.writeTextFile(
    join(runRoot, "transcript.json"),
    JSON.stringify(transcript),
  );
  await Deno.writeTextFile(
    join(runRoot, "run-report.json"),
    JSON.stringify({
      finalAssistantText: transcript.slice(firstGeneratedIndex).findLast(
        (message) => message.role === "assistant",
      )?.content ?? "",
      timeline: transcript.map((message, transcriptIndex) => ({
        kind: "transcript_message",
        transcriptIndex,
        role: message.role,
        ...(transcriptIndex >= firstGeneratedIndex ? { modelTurn: 1 } : {}),
      })),
    }),
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

  it("excludes pieces and assistant text inherited from earlier turns", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      await writeTranscript(artifactRoot, "follow-up-turn", [
        { role: "user", content: "build a reading list" },
        {
          role: "tool",
          toolCallId: "old-call",
          toolName: "assign_slug",
          content: JSON.stringify({
            status: "ok",
            slug: "old-piece",
            url: "http://localhost:8000/console-test/old-piece",
          }),
        },
        { role: "assistant", content: "The old piece is ready." },
        { role: "user", content: "calculate the total instead" },
        {
          role: "tool",
          toolCallId: "new-call",
          toolName: "run_pattern",
          content: JSON.stringify({ status: "ok" }),
        },
      ], 4);

      await expect(readConsoleTurnResult({
        artifactRoot,
        turnId: "follow-up-turn",
        spaceName: "console-test",
      })).resolves.toEqual({
        pieces: [],
        spaceName: "console-test",
        finalText: "",
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("rejects a run report whose generated transcript index is out of bounds", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      const turnId = "turn-with-invalid-index";
      await writeTranscript(artifactRoot, turnId, [
        { role: "user", content: "build a reading list" },
        { role: "assistant", content: "Your reading list is ready." },
      ]);
      await Deno.writeTextFile(
        join(artifactRoot, turnId, "run-report.json"),
        JSON.stringify({
          finalAssistantText: "Your reading list is ready.",
          timeline: [{
            kind: "transcript_message",
            transcriptIndex: 2,
            role: "assistant",
            modelTurn: 1,
          }],
        }),
      );

      await expect(readConsoleTurnResult({
        artifactRoot,
        turnId,
        spaceName: "console-test",
      })).resolves.toBeUndefined();
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("rejects unsafe run identifiers and malformed transcripts", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      await expect(readConsoleTurnResult({
        artifactRoot,
        turnId: "../another-run",
        spaceName: "console-test",
      })).resolves.toBeUndefined();

      const turnId = "turn-with-malformed-transcript";
      await writeTranscript(artifactRoot, turnId, [
        { role: "user", content: "build a reading list" },
      ]);
      await Deno.writeTextFile(
        join(artifactRoot, turnId, "transcript.json"),
        JSON.stringify([null]),
      );

      await expect(readConsoleTurnResult({
        artifactRoot,
        turnId,
        spaceName: "console-test",
      })).resolves.toBeUndefined();
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("ignores malformed and unsuccessful `assign_slug` outputs", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-console-result-",
    });
    try {
      const turnId = "turn-with-invalid-piece-outputs";
      await writeTranscript(artifactRoot, turnId, [
        { role: "user", content: "build a reading list" },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "assign_slug",
          content: "not JSON",
        },
        {
          role: "tool",
          toolCallId: "call-2",
          toolName: "assign_slug",
          content: JSON.stringify({ status: "error" }),
        },
        { role: "assistant", content: "I could not name it." },
      ]);

      await expect(readConsoleTurnResult({
        artifactRoot,
        turnId,
        spaceName: "console-test",
      })).resolves.toEqual({
        pieces: [],
        spaceName: "console-test",
        finalText: "I could not name it.",
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });
});
