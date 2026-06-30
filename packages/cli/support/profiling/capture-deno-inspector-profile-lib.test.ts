import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  markProfilerStarted,
  markProfileStoppedOnce,
  parseArg,
  parseNumberArg,
  type ProfileCaptureState,
  profileErrorOutputPath,
  type ProfileStopState,
  recordConsoleProfileMessage,
  requireArg,
  startProfilerIfReady,
  stopActiveProfiler,
  stringifyRemoteObject,
  waitForTarget,
  waitForWebSocketOpen,
  writeProfileCaptureFiles,
} from "./capture-deno-inspector-profile-lib.ts";

function createState(): ProfileCaptureState {
  return {
    consoleMessages: [],
    profilerActive: false,
    sawProfileStart: false,
    sawProfileStop: false,
  };
}

class FakeWebSocket {
  readyState: number = WebSocket.CONNECTING;
  added: string[] = [];
  removed: string[] = [];
  #listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.added.push(type);
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.removed.push(type);
    this.#listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event = new Event(type)): Event {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
    return event;
  }
}

describe("capture-deno-inspector-profile helpers", () => {
  it("parses named string arguments", () => {
    const args = ["--host=127.0.0.1", "--output=profile.cpuprofile"];

    assertEquals(parseArg(args, "host"), "127.0.0.1");
    assertEquals(parseArg(args, "missing"), undefined);
  });

  it("parses numeric arguments", () => {
    assertEquals(parseNumberArg([], "port", 9229), 9229);
    assertEquals(parseNumberArg(["--timeout=10.9"], "timeout", 0), 10);
    assertThrows(
      () => parseNumberArg(["--timeout=-1"], "timeout", 0),
      Error,
      "--timeout must be a non-negative number",
    );
  });

  it("requires non-empty arguments", () => {
    assertEquals(
      requireArg(["--output=profile.cpuprofile"], "output"),
      "profile.cpuprofile",
    );
    assertThrows(
      () => requireArg(["--output="], "output"),
      Error,
      "--output is required",
    );
  });

  it("waits for a matching inspector target", async () => {
    const endpoints: string[] = [];
    const target = await waitForTarget(
      "127.0.0.1",
      9229,
      1000,
      /mod\.ts$/,
      {
        fetchFn: (endpoint) => {
          endpoints.push(endpoint);
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                {
                  id: "worker",
                  type: "worker",
                  url: "file:///worker.ts",
                  webSocketDebuggerUrl: "ws://127.0.0.1/worker",
                },
                {
                  id: "node",
                  title: "CLI",
                  type: "node",
                  url: "file:///packages/cli/mod.ts",
                  webSocketDebuggerUrl: "ws://127.0.0.1/node",
                },
              ]),
          });
        },
        sleepMs: () => {
          throw new Error("matching target should not sleep");
        },
      },
    );

    assertEquals(target.id, "node");
    assertEquals(endpoints, ["http://127.0.0.1:9229/json/list"]);
  });

  it("retries inspector target lookup until the timeout expires", async () => {
    let fetches = 0;
    const times = [0, 0, 200];
    const sleeps: number[] = [];

    await assertRejects(
      () =>
        waitForTarget("127.0.0.1", 9229, 100, undefined, {
          fetchFn: () => {
            fetches += 1;
            throw new Error("not ready");
          },
          now: () => times.shift() ?? 200,
          sleepMs: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
        }),
      Error,
      "Timed out waiting for inspector target at http://127.0.0.1:9229/json/list",
    );

    assertEquals(fetches, 1);
    assertEquals(sleeps, [100]);
  });

  it("resolves when the websocket is already open", async () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;

    await waitForWebSocketOpen(ws as unknown as WebSocket);

    assertEquals(ws.added, []);
  });

  it("resolves after the websocket opens", async () => {
    const ws = new FakeWebSocket();
    const opened = waitForWebSocketOpen(ws as unknown as WebSocket);

    ws.dispatch("open");
    await opened;

    assertEquals(ws.added, ["open", "error"]);
    assertEquals(ws.removed, ["open", "error"]);
  });

  it("rejects when the websocket reports an error", async () => {
    const ws = new FakeWebSocket();
    const opened = waitForWebSocketOpen(ws as unknown as WebSocket);
    const event = ws.dispatch("error");

    let caught: unknown;
    try {
      await opened;
    } catch (error) {
      caught = error;
    }

    assertEquals(caught, event);
    assertEquals(ws.removed, ["open", "error"]);
  });

  it("formats remote console values", () => {
    assertEquals(stringifyRemoteObject({ value: 0 }), "0");
    assertEquals(stringifyRemoteObject({ unserializableValue: "NaN" }), "NaN");
    assertEquals(stringifyRemoteObject({ description: "Map(0)" }), "Map(0)");
    assertEquals(stringifyRemoteObject({ type: "object" }), "[object]");
    assertEquals(stringifyRemoteObject({}), "[unknown]");
  });

  it("starts the profiler when the websocket is open", async () => {
    const state = createState();
    const logs: string[] = [];
    let starts = 0;

    const started = await startProfilerIfReady(
      state,
      { readyState: WebSocket.OPEN },
      {
        start: () => {
          starts += 1;
          return Promise.resolve();
        },
      },
      (message) => logs.push(message),
    );

    assertEquals(started, true);
    assertEquals(starts, 1);
    assertEquals(state.profilerActive, true);
    assertEquals(state.sawProfileStop, false);
    assertEquals(logs, ["profile: profiler started"]);
  });

  it("marks profile stop once", () => {
    const state: ProfileStopState = { ended: false };

    assertEquals(markProfileStoppedOnce(state, "timeout"), true);
    assertEquals(markProfileStoppedOnce(state, "signal-SIGINT"), false);
    assertEquals(state, { ended: true, reason: "timeout" });
  });

  it("does not start the profiler twice", async () => {
    const state = createState();
    state.profilerActive = true;
    let starts = 0;

    const started = await startProfilerIfReady(
      state,
      { readyState: WebSocket.OPEN },
      {
        start: () => {
          starts += 1;
          return Promise.resolve();
        },
      },
    );

    assertEquals(started, false);
    assertEquals(starts, 0);
  });

  it("stops an active profiler", async () => {
    const state = createState();
    state.profilerActive = true;

    const result = await stopActiveProfiler(
      state,
      { readyState: WebSocket.OPEN },
      {
        stop: () => Promise.resolve({ profile: { nodes: [] } }),
      },
    );

    assertEquals(result, { profile: { nodes: [] }, stopError: undefined });
    assertEquals(state.profilerActive, false);
  });

  it("records profiler stop failures", async () => {
    const state = createState();
    state.profilerActive = true;

    const result = await stopActiveProfiler(
      state,
      { readyState: WebSocket.OPEN },
      {
        stop: () => Promise.reject(new Error("closed")),
      },
    );

    assertEquals(result.profile, null);
    assertEquals(result.stopError, "Profiler.stop failed: Error: closed");
    assertEquals(state.profilerActive, true);
  });

  it("skips stopping when the profiler is inactive", async () => {
    const state = createState();
    let stops = 0;

    const result = await stopActiveProfiler(
      state,
      { readyState: WebSocket.OPEN },
      {
        stop: () => {
          stops += 1;
          return Promise.resolve({ profile: {} });
        },
      },
    );

    assertEquals(result, { profile: null, stopError: undefined });
    assertEquals(stops, 0);
  });

  it("builds profiler error output paths", () => {
    assertEquals(
      profileErrorOutputPath("/tmp/profile.cpuprofile"),
      "/tmp/profile.error.txt",
    );
    assertEquals(
      profileErrorOutputPath("/tmp/profile.json"),
      "/tmp/profile.json.error.txt",
    );
  });

  it("writes captured profile and console files", async () => {
    const state = createState();
    state.consoleMessages.push("one", "two");
    const writes: Array<[string, string]> = [];
    const mkdirs: string[] = [];

    await writeProfileCaptureFiles({
      outputPath: "/tmp/profile.cpuprofile",
      consoleOutputPath: "/tmp/profile.console.log",
      state,
      profile: { nodes: [] },
      writer: {
        mkdir: (path) => {
          mkdirs.push(path);
          return Promise.resolve();
        },
        writeTextFile: (path, data) => {
          writes.push([path, data]);
          return Promise.resolve();
        },
      },
    });

    assertEquals(mkdirs, ["/tmp"]);
    assertEquals(writes, [
      ["/tmp/profile.cpuprofile", JSON.stringify({ nodes: [] }, null, 2)],
      ["/tmp/profile.console.log", "one\ntwo"],
    ]);
  });

  it("writes profiler stop errors", async () => {
    const state = createState();
    const writes: Array<[string, string]> = [];

    await writeProfileCaptureFiles({
      outputPath: "/tmp/profile.cpuprofile",
      state,
      profile: null,
      stopError: "stop failed",
      writer: {
        mkdir: () => Promise.reject(new Error("exists")),
        writeTextFile: (path, data) => {
          writes.push([path, data]);
          return Promise.resolve();
        },
      },
    });

    assertEquals(writes, [["/tmp/profile.error.txt", "stop failed"]]);
  });

  it("marks start and stop latches from console messages", () => {
    const state = createState();

    recordConsoleProfileMessage(
      state,
      "begin profile",
      /begin profile/,
      /stop profile/,
    );
    recordConsoleProfileMessage(
      state,
      "stop profile",
      /begin profile/,
      /stop profile/,
    );

    expect(state.consoleMessages).toEqual(["begin profile", "stop profile"]);
    expect(state.sawProfileStart).toBe(true);
    expect(state.sawProfileStop).toBe(true);
  });

  it("clears an early stop latch when profiling actually starts", () => {
    const state = createState();
    state.sawProfileStop = true;

    markProfilerStarted(state);

    expect(state.profilerActive).toBe(true);
    expect(state.sawProfileStop).toBe(false);
  });
});
