import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertEquals } from "@std/assert";
import {
  markProfilerStarted,
  markProfileStoppedOnce,
  type ProfileCaptureState,
  type ProfileStopState,
  recordConsoleProfileMessage,
  resumeDebuggerOnPause,
  sendInspectorCommand,
  startProfilerIfReady,
} from "./capture-deno-inspector-profile-lib.ts";

function createState(): ProfileCaptureState {
  return {
    consoleMessages: [],
    profilerActive: false,
    profilerStarting: false,
    sawProfileStart: false,
    sawProfileStop: false,
  };
}

class FakeWebSocket {
  readyState: number = WebSocket.CONNECTING;
  added: string[] = [];
  removed: string[] = [];
  sent: string[] = [];
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

  send(data: string): void {
    this.sent.push(data);
  }
}

describe("capture-deno-inspector-profile helpers", () => {
  it("resumes once when the debugger pauses", () => {
    const target = new EventTarget();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;

    resumeDebuggerOnPause(target, ws as unknown as WebSocket, -2);
    target.dispatchEvent(new Event("Debugger.paused"));
    target.dispatchEvent(new Event("Debugger.paused"));

    assertEquals(ws.sent, [
      '{"id":-2,"method":"Debugger.resume","params":{}}',
    ]);
  });

  it("can stop listening for debugger pauses", () => {
    const target = new EventTarget();
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;

    const stopListening = resumeDebuggerOnPause(
      target,
      ws as unknown as WebSocket,
      -2,
    );
    stopListening();
    target.dispatchEvent(new Event("Debugger.paused"));

    assertEquals(ws.sent, []);
  });

  it("sends inspector commands when the websocket is open", () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.OPEN;

    assertEquals(
      sendInspectorCommand(ws as unknown as WebSocket, -1, "Debugger.resume"),
      true,
    );

    assertEquals(ws.sent, [
      '{"id":-1,"method":"Debugger.resume","params":{}}',
    ]);
  });

  it("skips inspector commands when the websocket is closed", () => {
    const ws = new FakeWebSocket();
    ws.readyState = WebSocket.CLOSED;

    assertEquals(
      sendInspectorCommand(ws as unknown as WebSocket, -1, "Debugger.resume"),
      false,
    );
    assertEquals(ws.sent, []);
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

  it("can preserve a stop latch when the profiler starts", async () => {
    const state = createState();
    state.sawProfileStop = true;

    const started = await startProfilerIfReady(
      state,
      { readyState: WebSocket.OPEN },
      { start: () => Promise.resolve() },
      () => {},
      { clearStop: false },
    );

    assertEquals(started, true);
    assertEquals(state.profilerActive, true);
    assertEquals(state.sawProfileStop, true);
  });

  it("marks profile stop once", () => {
    const state: ProfileStopState = { ended: false };

    assertEquals(markProfileStoppedOnce(state, "summary-matched"), true);
    assertEquals(markProfileStoppedOnce(state, "signal-SIGINT"), false);
    assertEquals(state, { ended: true, reason: "summary-matched" });
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

  it("does not start the profiler while a start is already in flight", async () => {
    const state = createState();
    let resolveStart: (() => void) | undefined;
    let starts = 0;

    const firstStart = startProfilerIfReady(
      state,
      { readyState: WebSocket.OPEN },
      {
        start: () => {
          starts += 1;
          return new Promise<void>((resolve) => {
            resolveStart = resolve;
          });
        },
      },
    );
    assertEquals(state.profilerStarting, true);

    const secondStarted = await startProfilerIfReady(
      state,
      { readyState: WebSocket.OPEN },
      {
        start: () => {
          starts += 1;
          return Promise.resolve();
        },
      },
    );
    resolveStart?.();
    const firstStarted = await firstStart;

    assertEquals(secondStarted, false);
    assertEquals(firstStarted, true);
    assertEquals(starts, 1);
    assertEquals(state.profilerStarting, false);
    assertEquals(state.profilerActive, true);
  });

  it("marks start and stop latches from console messages", () => {
    const state = createState();

    const startMessage = recordConsoleProfileMessage(
      state,
      "begin profile",
      /begin profile/,
      /stop profile/,
    );
    const stopMessage = recordConsoleProfileMessage(
      state,
      "stop profile",
      /begin profile/,
      /stop profile/,
    );

    expect(startMessage).toEqual({
      startedProfile: true,
      hadProfileStop: false,
    });
    expect(stopMessage).toEqual({
      startedProfile: false,
      hadProfileStop: false,
    });
    expect(state.consoleMessages).toEqual(["begin profile", "stop profile"]);
    expect(state.sawProfileStart).toBe(true);
    expect(state.sawProfileStop).toBe(true);
  });

  it("reports whether a stop latch existed before a start message", () => {
    const state = createState();
    state.sawProfileStop = true;

    const message = recordConsoleProfileMessage(
      state,
      "begin profile",
      /begin profile/,
      /stop profile/,
    );

    expect(message).toEqual({
      startedProfile: true,
      hadProfileStop: true,
    });
  });

  it("clears an early stop latch when profiling actually starts", () => {
    const state = createState();
    state.sawProfileStop = true;

    markProfilerStarted(state);

    expect(state.profilerActive).toBe(true);
    expect(state.sawProfileStop).toBe(false);
  });
});
