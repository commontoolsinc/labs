import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { collectSource, prepareSession } from "../src/reconcile.ts";
import type {
  AgentDriver,
  NativeSessionSnapshot,
  SessionPage,
} from "../src/types.ts";

describe("reconcile", () => {
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

  it("consumes every page and prepares stable session snapshots", async () => {
    await using collected = await collectSource(fakeDriver());
    const sessions = await Array.fromAsync(collected.sessions);
    assertEquals(collected.complete, true);
    assertEquals(
      sessions.map((session) => session.summary.nativeSessionId),
      ["one", "two"],
    );

    const first = await prepareSession("fake:default", sessions[0], 64);
    const again = await prepareSession("fake:default", sessions[0], 64);
    assertEquals(first, again);
    assertEquals(first.key, "fake%3Adefault/one");
    assertEquals(first.chunks[0].events, [{
      id: "one-message",
      text: "hello",
    }]);
    assertEquals(first.snapshotHash.startsWith("sha256:"), true);
  });

  it("retains lifecycle state reported only by inventory", async () => {
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

    await using collected = await collectSource(driver);

    const sessions = await Array.fromAsync(collected.sessions);
    assertEquals(sessions[0].summary.archived, true);
    assertEquals(sessions[0].summary.active, false);
  });

  it("rejects an oversized terminal inventory page", async () => {
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

    await using collected = await collectSource(driver);

    assertEquals(collected.complete, false);
    assertEquals(await Array.fromAsync(collected.sessions), []);
    assertEquals(collected.errors, [{
      message: "Error: session enumeration exceeded safety limit",
    }]);
    assertEquals(readCalls, 0);
  });

  it("reads each inventory page before requesting the next page", async () => {
    const driver = fakeDriver();
    const calls: string[] = [];
    const list = driver.listSessions;
    const read = driver.readSession;
    driver.listSessions = (cursor) => {
      calls.push(`list:${cursor ?? "first"}`);
      return list(cursor);
    };
    driver.readSession = (id) => {
      calls.push(`read:${id}`);
      return read(id);
    };
    await using collected = await collectSource(driver);
    expect(calls).toEqual(["list:first", "read:one", "list:next", "read:two"]);
    expect(collected.complete).toBe(true);
  });

  it("retains successful reads and reports failed session reads", async () => {
    const driver = fakeDriver();
    const read = driver.readSession;
    driver.readSession = (id) =>
      id === "one"
        ? Promise.reject(new Error("session unavailable"))
        : read(id);
    await using collected = await collectSource(driver);
    expect(collected.complete).toBe(false);
    expect(collected.errors).toEqual([{
      nativeSessionId: "one",
      message: "Error: session unavailable",
    }]);
    const sessions = await Array.fromAsync(collected.sessions);
    expect(sessions.map((value) => value.summary.nativeSessionId)).toEqual([
      "two",
    ]);
  });

  it("retains collected sessions after an inventory failure", async () => {
    const driver = fakeDriver();
    const list = driver.listSessions;
    driver.listSessions = (cursor) =>
      cursor ? Promise.reject(new Error("inventory unavailable")) : list();
    await using collected = await collectSource(driver);
    expect(collected.complete).toBe(false);
    expect(collected.sessions.length).toBe(1);
    expect(collected.errors).toEqual([{
      message: "Error: inventory unavailable",
    }]);
  });

  it("reports a repeated cursor after empty inventory pages", async () => {
    const driver = fakeDriver();
    driver.listSessions = () =>
      Promise.resolve({ sessions: [], nextCursor: "again" });
    await using collected = await collectSource(driver);
    expect(collected.complete).toBe(false);
    expect(collected.sessions.length).toBe(0);
    expect(collected.errors).toEqual([{
      message: "Error: repeated session cursor: again",
    }]);
  });

  for (const failure of ["cancellation", "spool write"] as const) {
    it(`removes the temporary spool after ${failure} failure`, async () => {
      const originalMakeTempDir = Deno.makeTempDir;
      let directory: string | undefined;
      using _directory = stub(Deno, "makeTempDir", async (options) => {
        directory = await originalMakeTempDir(options);
        return directory;
      });
      const driver = fakeDriver();
      const controller = new AbortController();
      if (failure === "cancellation") {
        const list = driver.listSessions;
        driver.listSessions = (cursor) => {
          if (cursor) controller.abort(new Error("collection cancelled"));
          return list(cursor);
        };
        await expect(collectSource(driver, controller.signal)).rejects.toThrow(
          "collection cancelled",
        );
      } else {
        using _write = stub(
          Deno,
          "writeTextFile",
          () => Promise.reject(new Error("disk full")),
        );
        await expect(collectSource(driver)).rejects.toThrow("disk full");
      }
      expect(directory).toBeDefined();
      await expect(Deno.stat(directory!)).rejects.toThrow(Deno.errors.NotFound);
    });
  }
});
