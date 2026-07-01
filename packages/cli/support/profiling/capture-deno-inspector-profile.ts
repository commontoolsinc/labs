import { Celestial } from "../../../../packages/vendor-astral/bindings/celestial.ts";
import {
  markProfileStoppedOnce,
  parseArg,
  type ProfileCaptureState,
  type ProfileStopState,
  recordConsoleProfileMessage,
  requireArg,
  resumeDebuggerOnPause,
  sendInspectorCommand,
  startProfilerIfReady,
  stopActiveProfiler,
  stringifyRemoteObject,
  waitForWebSocketOpen,
  writeProfileCaptureFiles,
} from "./capture-deno-inspector-profile-lib.ts";

const outputPath = requireArg(Deno.args, "output");
const consoleOutputPath = parseArg(Deno.args, "console-output");
const summaryPattern = parseArg(Deno.args, "summary-pattern") ??
  "\\d+ passed, \\d+ failed";
const profileStartPattern = parseArg(Deno.args, "profile-start-pattern");
const profileStopPattern = parseArg(Deno.args, "profile-stop-pattern");
const websocketUrl = requireArg(Deno.args, "websocket-url");

const target = {
  id: websocketUrl,
  title: websocketUrl,
  type: "node",
  webSocketDebuggerUrl: websocketUrl,
};
console.log(`profile: target ${target.title ?? target.id}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await waitForWebSocketOpen(ws);
console.log("profile: websocket open");

const celestial = new Celestial(ws);
const summaryRegex = new RegExp(summaryPattern);
const profileStartRegex = profileStartPattern
  ? new RegExp(profileStartPattern)
  : undefined;
const profileStopRegex = profileStopPattern
  ? new RegExp(profileStopPattern)
  : undefined;
const profileStopState: ProfileStopState = {
  ended: false,
};
const stopReason = Promise.withResolvers<string>();
let stopReasonSent = false;
const state: ProfileCaptureState = {
  consoleMessages: [],
  profilerActive: false,
  profilerStarting: false,
  sawProfileStart: !profileStartRegex,
  sawProfileStop: false,
};
let pendingProfilerStopReason: string | undefined;
let profilerStartError: string | undefined;

function requestStop(reason: string): void {
  if (stopReasonSent) return;
  stopReasonSent = true;
  stopReason.resolve(reason);
}

function requestProfilerStop(reason: string): void {
  if (state.profilerStarting) {
    pendingProfilerStopReason ??= reason;
    return;
  }
  requestStop(reason);
}

function recordProfilerStartError(error: unknown): void {
  if (profilerStartError) return;
  profilerStartError = `Profiler.start failed: ${error}`;
  console.error(`profile: ${profilerStartError}`);
  requestStop("profiler-start-failed");
}

celestial.addEventListener("Runtime.consoleAPICalled", (event) => {
  const text = event.detail.args
    .map((arg) => stringifyRemoteObject(arg as Record<string, unknown>))
    .join(" ");
  const profileMessage = recordConsoleProfileMessage(
    state,
    text,
    profileStartRegex,
    profileStopRegex,
  );
  if (profileMessage.startedProfile) {
    void startProfiler({ clearStop: profileMessage.hadProfileStop });
  }
  if (summaryRegex.test(text)) {
    requestProfilerStop("summary-matched");
  }
  if (state.profilerActive && state.sawProfileStop) {
    requestProfilerStop("profile-stop-matched");
  }
});

async function startProfiler(options: { clearStop?: boolean } = {}) {
  let started = false;
  try {
    started = await startProfilerIfReady(
      state,
      ws,
      celestial.Profiler,
      console.log,
      options,
    );
  } catch (error) {
    recordProfilerStartError(error);
    return;
  }
  if (started && state.sawProfileStop) {
    pendingProfilerStopReason ??= "profile-stop-matched";
  }
  if (started && pendingProfilerStopReason) {
    const reason = pendingProfilerStopReason;
    pendingProfilerStopReason = undefined;
    requestStop(reason);
  }
}

const signalHandlers: Array<[Deno.Signal, () => void]> = [];
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  try {
    const handler = () => {
      requestProfilerStop(`signal-${signal}`);
    };
    Deno.addSignalListener(signal, handler);
    signalHandlers.push([signal, handler]);
  } catch {
    // Signals are best-effort here.
  }
}

async function stopProfile(reason: string) {
  if (markProfileStoppedOnce(profileStopState, reason)) {
    const { profile, stopError } = await stopActiveProfiler(
      state,
      ws,
      celestial.Profiler,
    );
    await writeProfileCaptureFiles({
      outputPath,
      consoleOutputPath,
      state,
      profile,
      stopError: profilerStartError ?? stopError,
    });
  }
}

await celestial.Runtime.enable();
console.log("profile: runtime enabled");
await celestial.Console.enable();
await celestial.Debugger.enable({});
await celestial.Profiler.enable();
await celestial.Profiler.setSamplingInterval({ interval: 100 });

if (state.sawProfileStart) {
  await startProfiler();
}

const stopResumeOnPause = resumeDebuggerOnPause(celestial, ws, -2);
const handleClose = () => requestStop("websocket-closed");
ws.addEventListener("close", handleClose);
sendInspectorCommand(ws, -1, "Runtime.runIfWaitingForDebugger");
console.log("profile: resumed target");

if (ws.readyState === WebSocket.CLOSED) {
  requestStop("websocket-closed");
}

const reason = await stopReason.promise;
await stopProfile(reason);
if (reason === "profile-stop-matched") {
  console.log("profile: profile stop matched");
} else if (reason === "summary-matched") {
  console.log("profile: summary matched");
} else if (reason === "websocket-closed") {
  console.log("profile: websocket closed");
} else {
  console.log(`profile: ${reason}`);
}

for (const [signal, handler] of signalHandlers) {
  try {
    Deno.removeSignalListener(signal, handler);
  } catch {
    // Listener may already be gone.
  }
}

ws.removeEventListener("close", handleClose);
stopResumeOnPause();
await celestial.close();

console.log(
  JSON.stringify(
    {
      reason: profileStopState.reason,
      outputPath,
      consoleMessages: state.consoleMessages.length,
    },
    null,
    2,
  ),
);

if (profilerStartError) {
  Deno.exit(1);
}
