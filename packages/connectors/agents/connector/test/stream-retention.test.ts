import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { streamSource } from "../src/reconcile.ts";
import type { AgentDriver, SessionSummary } from "../src/types.ts";

/** Constructs a paginated driver which records transcript reads. */
function fixture(repeatFirst = false) {
  const summaries: SessionSummary[] = ["one", "two"].map((id) => ({
    nativeSessionId: id,
    title: id,
    cwd: null,
    createdAt: null,
    updatedAt: null,
    archived: false,
    active: false,
    raw: {},
  }));
  const reads: string[] = [];
  const driver: AgentDriver = {
    source: {
      id: "sample",
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
    listSessions: (cursor) =>
      Promise.resolve(
        cursor
          ? { sessions: repeatFirst ? summaries : [summaries[1]] }
          : { sessions: [summaries[0]], nextCursor: "next" },
      ),
    readSession: (id) => {
      reads.push(id);
      return Promise.resolve({
        summary: summaries.find((summary) => summary.nativeSessionId === id)!,
        events: [],
        normalizedMessages: [],
        complete: true,
      });
    },
    prompt: () => Promise.resolve({ status: "unsupported" }),
    startSession: () => Promise.resolve({ status: "unsupported" }),
    cancel: () => Promise.resolve({ status: "unsupported" }),
    renameSession: () => Promise.resolve({ status: "unsupported" }),
    setMode: () => Promise.resolve({ status: "unsupported" }),
    setConfigOption: () => Promise.resolve({ status: "unsupported" }),
  };
  return { driver, reads };
}

describe("streamSource()", () => {
  it("retains an accepted summary and reads the other session", async () => {
    const { driver, reads } = fixture();
    const collected = streamSource(
      driver,
      undefined,
      (summary) => summary.nativeSessionId === "one",
    );
    const sessions = [];
    for await (const session of collected.sessions) sessions.push(session);

    expect(reads).toEqual(["two"]);
    expect(sessions.map((session) => session.summary.nativeSessionId))
      .toEqual(["two"]);
    expect(collected.retained.map((summary) => summary.nativeSessionId))
      .toEqual(["one"]);
    expect(collected.outcome).toEqual({
      errors: [],
      complete: true,
      sessionCount: 1,
      consumed: true,
    });
  });

  for (const retainFirst of [false, true]) {
    it(`records a duplicate once when retention is ${retainFirst}`, async () => {
      const { driver, reads } = fixture(true);
      const collected = streamSource(
        driver,
        undefined,
        (summary) => retainFirst && summary.nativeSessionId === "one",
      );
      const sessions = [];
      for await (const session of collected.sessions) sessions.push(session);

      expect(reads).toEqual(retainFirst ? ["two"] : ["one", "two"]);
      expect(sessions.length).toBe(reads.length);
      expect(collected.retained.map((summary) => summary.nativeSessionId))
        .toEqual(retainFirst ? ["one"] : []);
      expect(collected.outcome.complete).toBe(false);
      expect(collected.outcome.errors).toEqual([{
        nativeSessionId: "one",
        message: "duplicate session in inventory: one",
      }]);
    });
  }
});
