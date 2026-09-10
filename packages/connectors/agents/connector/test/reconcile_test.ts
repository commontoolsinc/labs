import { assertEquals } from "@std/assert";
import { collectSource, prepareSession } from "../src/reconcile.ts";
import type {
  AgentDriver,
  NativeSessionSnapshot,
  SessionPage,
} from "../src/types.ts";

function fakeDriver(): AgentDriver {
  const summaries = ["one", "two"].map((id) => ({
    nativeSessionId: id,
    title: id,
    cwd: null,
    createdAt: null,
    updatedAt: null,
    archived: false,
    active: false,
    raw: { id },
  }));
  return {
    source: {
      id: "fake:default",
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
    listSessions: (cursor?: string): Promise<SessionPage> =>
      Promise.resolve(
        cursor
          ? { sessions: [summaries[1]] }
          : { sessions: [summaries[0]], nextCursor: "next" },
      ),
    readSession: (id: string): Promise<NativeSessionSnapshot> =>
      Promise.resolve({
        summary: summaries.find((summary) => summary.nativeSessionId === id)!,
        events: [{ id: `${id}-message`, text: "hello" }],
        normalizedMessages: [],
        complete: true,
      }),
    prompt: () => Promise.resolve({ status: "unsupported" }),
    cancel: () => Promise.resolve({ status: "unsupported" }),
    renameSession: () => Promise.resolve({ status: "unsupported" }),
    setMode: () => Promise.resolve({ status: "unsupported" }),
    setConfigOption: () => Promise.resolve({ status: "unsupported" }),
  };
}

Deno.test("collectSource consumes every page and prepares stable session snapshots", async () => {
  const collected = await collectSource(fakeDriver());
  assertEquals(collected.complete, true);
  assertEquals(
    collected.sessions.map((session) => session.summary.nativeSessionId),
    ["one", "two"],
  );

  const first = await prepareSession("fake:default", collected.sessions[0], 64);
  const again = await prepareSession("fake:default", collected.sessions[0], 64);
  assertEquals(first, again);
  assertEquals(first.key, "fake%3Adefault/one");
  assertEquals(first.chunks[0].events, [{ id: "one-message", text: "hello" }]);
  assertEquals(first.snapshotHash.startsWith("sha256:"), true);
});

Deno.test("collectSource retains lifecycle state reported only by inventory", async () => {
  const inventorySummary = {
    nativeSessionId: "one",
    title: "one",
    cwd: null,
    createdAt: null,
    updatedAt: null,
    archived: true,
    active: false,
    raw: { id: "one", archived: true },
  };
  const driver: AgentDriver = {
    ...fakeDriver(),
    listSessions: () => Promise.resolve({ sessions: [inventorySummary] }),
    readSession: () =>
      Promise.resolve({
        summary: {
          ...inventorySummary,
          archived: null,
          active: null,
          raw: { id: "one" },
        },
        events: [],
        normalizedMessages: [],
        complete: true,
      }),
  };

  const collected = await collectSource(driver);

  assertEquals(collected.sessions[0].summary.archived, true);
  assertEquals(collected.sessions[0].summary.active, false);
});

Deno.test("collectSource rejects an oversized terminal inventory page", async () => {
  const summary = {
    nativeSessionId: "one",
    title: "one",
    cwd: null,
    createdAt: null,
    updatedAt: null,
    archived: false,
    active: false,
    raw: { id: "one" },
  };
  let readCalls = 0;
  const driver: AgentDriver = {
    ...fakeDriver(),
    listSessions: () =>
      Promise.resolve({ sessions: Array(100_001).fill(summary) }),
    readSession: () => {
      readCalls++;
      return Promise.reject(new Error("oversized inventory was read"));
    },
  };

  const collected = await collectSource(driver);

  assertEquals(collected.complete, false);
  assertEquals(collected.sessions, []);
  assertEquals(collected.errors, [{
    message: "Error: session enumeration exceeded safety limit",
  }]);
  assertEquals(readCalls, 0);
});
