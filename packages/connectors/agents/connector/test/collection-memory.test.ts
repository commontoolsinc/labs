/** Exercises collection in a separate process with a constrained V8 heap. */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import { collectSource } from "../src/reconcile.ts";
import type { AgentDriver, SessionSummary } from "../src/types.ts";

const sessionCount = 96;
const transcriptBytes = 4 * 1024 * 1024;

/** Collects and reads a corpus whose transcripts exceed the child's heap. */
async function exerciseCollection(): Promise<void> {
  const summary = (id: string): SessionSummary => ({
    nativeSessionId: id,
    title: id,
    cwd: null,
    createdAt: null,
    updatedAt: null,
    archived: false,
    active: false,
    raw: { id },
  });
  const driver: AgentDriver = {
    source: {
      id: "test:memory",
      driver: "acp",
      capabilities: {
        inventory: true,
        read: true,
        prompt: false,
        cancel: false,
        rename: false,
        setMode: false,
        setConfigOption: false,
      },
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    listSessions: (cursor) => {
      const index = Number(cursor ?? 0);
      return Promise.resolve({
        sessions: [summary(String(index))],
        nextCursor: index + 1 < sessionCount ? String(index + 1) : undefined,
      });
    },
    readSession: (id) =>
      Promise.resolve({
        summary: summary(id),
        events: [new TextDecoder().decode(
          new Uint8Array(transcriptBytes).fill(Number(id) + 32),
        )],
        normalizedMessages: [],
        complete: true,
      }),
    prompt: () => Promise.resolve({ status: "unsupported" }),
    cancel: () => Promise.resolve({ status: "unsupported" }),
    renameSession: () => Promise.resolve({ status: "unsupported" }),
    setMode: () => Promise.resolve({ status: "unsupported" }),
    setConfigOption: () => Promise.resolve({ status: "unsupported" }),
  };
  await using collected = await collectSource(driver);
  expect(collected.complete).toBe(true);
  expect(collected.sessions.length).toBe(sessionCount);
  let index = 0;
  for await (const snapshot of collected.sessions) {
    expect(snapshot.summary.nativeSessionId).toBe(String(index));
    const transcript = snapshot.events[0] as string;
    expect(transcript.length).toBe(transcriptBytes);
    expect(transcript.charCodeAt(0)).toBe(index + 32);
    expect(transcript.charCodeAt(transcript.length - 1)).toBe(index + 32);
    index++;
  }
  expect(index).toBe(sessionCount);
  console.log(`Read ${index * transcriptBytes} transcript bytes`);
}

if (import.meta.main) {
  await exerciseCollection();
} else {
  describe("collection memory", () => {
    it("collects and replays 384 MiB of transcripts with a 192 MiB heap", async () => {
      const result = await runDenoCommandWithTemporaryLock({
        root: fromFileUrl(new URL("../../../../../", import.meta.url)),
        args: (lock) => [
          "run",
          "--frozen=true",
          "--lock",
          lock,
          "--allow-env",
          "--allow-read",
          "--allow-write",
          "--v8-flags=--max-old-space-size=192",
          fromFileUrl(import.meta.url),
        ],
      });
      expect(result.success, new TextDecoder().decode(result.stderr)).toBe(
        true,
      );
      expect(new TextDecoder().decode(result.stdout)).toContain(
        `Read ${sessionCount * transcriptBytes} transcript bytes`,
      );
    });
  });
}
