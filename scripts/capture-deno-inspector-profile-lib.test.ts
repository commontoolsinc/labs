import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  markProfilerStarted,
  type ProfileCaptureState,
  recordConsoleProfileMessage,
} from "./capture-deno-inspector-profile-lib.ts";

function createState(): ProfileCaptureState {
  return {
    consoleMessages: [],
    profilerActive: false,
    sawProfileStart: false,
    sawProfileStop: false,
  };
}

describe("capture-deno-inspector-profile helpers", () => {
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
