import { Celestial } from "../../../../packages/vendor-astral/bindings/celestial.ts";
import {
  markProfileStoppedOnce,
  parseArg,
  parseNumberArg,
  type ProfileCaptureState,
  type ProfileStopState,
  recordConsoleProfileMessage,
  requireArg,
  resumeDebuggerOnPause,
  sendInspectorCommand,
  sleep,
  startProfilerIfReady,
  stopActiveProfiler,
  stringifyRemoteObject,
  waitForTarget,
  waitForWebSocketOpen,
  writeProfileCaptureFiles,
} from "./capture-deno-inspector-profile-lib.ts";

const host = parseArg(Deno.args, "host") ?? "127.0.0.1";
const port = parseNumberArg(Deno.args, "port", 9229);
const outputPath = requireArg(Deno.args, "output");
const consoleOutputPath = parseArg(Deno.args, "console-output");
const summaryPattern = parseArg(Deno.args, "summary-pattern") ??
  "\\d+ passed, \\d+ failed";
const profileStartPattern = parseArg(Deno.args, "profile-start-pattern");
const profileStopPattern = parseArg(Deno.args, "profile-stop-pattern");
const targetUrlPattern = parseArg(Deno.args, "target-url-pattern");
const connectTimeoutMs = parseNumberArg(Deno.args, "connect-timeout", 30_000);
const timeoutMs = parseNumberArg(Deno.args, "timeout", 120_000);

const target = await waitForTarget(
  host,
  port,
  connectTimeoutMs,
  targetUrlPattern ? new RegExp(targetUrlPattern) : undefined,
);
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
const state: ProfileCaptureState = {
  consoleMessages: [],
  profilerActive: false,
  profilerStarting: false,
  sawProfileStart: !profileStartRegex,
  sawProfileStop: false,
};

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
});

async function startProfiler(options: { clearStop?: boolean } = {}) {
  await startProfilerIfReady(
    state,
    ws,
    celestial.Profiler,
    console.log,
    options,
  );
}

const signalHandlers: Array<[Deno.Signal, () => void]> = [];
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  try {
    const handler = () => {
      profileStopState.reason ??= `signal-${signal}`;
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
      stopError,
    });
  }
}

await celestial.Runtime.enable();
console.log("profile: runtime enabled");
await celestial.Console.enable();
await celestial.Debugger.enable();
await celestial.Profiler.enable();
await celestial.Profiler.setSamplingInterval({ interval: 100 });

if (state.sawProfileStart) {
  await startProfiler();
}

const stopResumeOnPause = resumeDebuggerOnPause(celestial, ws, -2, 100);
sendInspectorCommand(ws, -1, "Runtime.runIfWaitingForDebugger");
console.log("profile: resumed target");

const started = performance.now();
while (performance.now() - started < timeoutMs) {
  if (profileStopState.reason) {
    await stopProfile(profileStopState.reason);
    console.log(`profile: ${profileStopState.reason}`);
    break;
  }
  if (
    state.sawProfileStart && !state.profilerActive && !state.profilerStarting
  ) {
    await startProfiler();
  }
  if (state.profilerActive && state.sawProfileStop) {
    await stopProfile("profile-stop-matched");
    console.log("profile: profile stop matched");
    break;
  }
  if (state.consoleMessages.some((message) => summaryRegex.test(message))) {
    await stopProfile("summary-matched");
    console.log("profile: summary matched");
    break;
  }
  if (ws.readyState === WebSocket.CLOSED) {
    await stopProfile("websocket-closed");
    console.log("profile: websocket closed");
    break;
  }
  await sleep(100);
}

if (!profileStopState.ended) {
  await stopProfile("timeout");
  console.log("profile: timeout");
}

for (const [signal, handler] of signalHandlers) {
  try {
    Deno.removeSignalListener(signal, handler);
  } catch {
    // Listener may already be gone.
  }
}

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
