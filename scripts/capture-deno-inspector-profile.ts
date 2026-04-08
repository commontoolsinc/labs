import { Celestial } from "../packages/vendor-astral/bindings/celestial.ts";
import { dirname } from "@std/path";
import {
  markProfilerStarted,
  type ProfileCaptureState,
  recordConsoleProfileMessage,
} from "./capture-deno-inspector-profile-lib.ts";

type InspectorTarget = {
  description?: string;
  id: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl: string;
};

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of Deno.args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function parseNumberArg(name: string, defaultValue: number): number {
  const raw = parseArg(name);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return Math.floor(value);
}

function requireArg(name: string): string {
  const value = parseArg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const handleOpen = () => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
      resolve();
    };
    const handleError = (event: Event) => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
      reject(event);
    };

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("error", handleError);
  });
}

function stringifyRemoteObject(value: Record<string, unknown>): string {
  if ("value" in value && value.value !== undefined) {
    return String(value.value);
  }
  if ("unserializableValue" in value && value.unserializableValue) {
    return String(value.unserializableValue);
  }
  if ("description" in value && value.description) {
    return String(value.description);
  }
  if ("type" in value) {
    return `[${String(value.type)}]`;
  }
  return "[unknown]";
}

async function waitForTarget(
  host: string,
  port: number,
  timeoutMs: number,
  targetUrlPattern?: RegExp,
): Promise<InspectorTarget> {
  const started = performance.now();
  const endpoint = `http://${host}:${port}/json/list`;

  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const targets = await response.json() as InspectorTarget[];
        const match = targets.find((target) =>
          target.type === "node" &&
          (!targetUrlPattern || targetUrlPattern.test(target.url ?? ""))
        );
        if (match) return match;
      }
    } catch {
      // Retry until timeout.
    }
    await sleep(100);
  }

  throw new Error(`Timed out waiting for inspector target at ${endpoint}`);
}

const host = parseArg("host") ?? "127.0.0.1";
const port = parseNumberArg("port", 9229);
const outputPath = requireArg("output");
const consoleOutputPath = parseArg("console-output");
const summaryPattern = parseArg("summary-pattern") ??
  "\\d+ passed, \\d+ failed";
const profileStartPattern = parseArg("profile-start-pattern");
const profileStopPattern = parseArg("profile-stop-pattern");
const targetUrlPattern = parseArg("target-url-pattern");
const connectTimeoutMs = parseNumberArg("connect-timeout", 30_000);
const timeoutMs = parseNumberArg("timeout", 120_000);

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
let profileEnded = false;
let stopReason: string | undefined;
const state: ProfileCaptureState = {
  consoleMessages: [],
  profilerActive: false,
  sawProfileStart: !profileStartRegex,
  sawProfileStop: false,
};

celestial.addEventListener("Runtime.consoleAPICalled", (event) => {
  const text = event.detail.args
    .map((arg) => stringifyRemoteObject(arg as Record<string, unknown>))
    .join(" ");
  recordConsoleProfileMessage(
    state,
    text,
    profileStartRegex,
    profileStopRegex,
  );
});

async function startProfiler() {
  if (state.profilerActive || ws.readyState !== WebSocket.OPEN) return;
  await celestial.Profiler.start();
  markProfilerStarted(state);
  console.log("profile: profiler started");
}

const signalHandlers: Array<[Deno.Signal, () => void]> = [];
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  try {
    const handler = () => {
      stopReason ??= `signal-${signal}`;
    };
    Deno.addSignalListener(signal, handler);
    signalHandlers.push([signal, handler]);
  } catch {
    // Signals are best-effort here.
  }
}

async function stopProfile(reason: string) {
  if (profileEnded) return;
  profileEnded = true;
  stopReason ??= reason;

  let profile: unknown = null;
  let stopError: string | undefined;
  const errorOutputPath = outputPath.endsWith(".cpuprofile")
    ? outputPath.replace(/\.cpuprofile$/i, ".error.txt")
    : `${outputPath}.error.txt`;
  if (state.profilerActive && ws.readyState === WebSocket.OPEN) {
    try {
      profile = (await celestial.Profiler.stop()).profile;
      state.profilerActive = false;
    } catch (error) {
      stopError = `Profiler.stop failed: ${error}`;
    }
  }

  await Deno.mkdir(dirname(outputPath), { recursive: true }).catch(() => {});
  if (profile) {
    await Deno.writeTextFile(outputPath, JSON.stringify(profile, null, 2));
  } else if (stopError) {
    await Deno.writeTextFile(errorOutputPath, stopError);
  }

  if (consoleOutputPath) {
    await Deno.writeTextFile(
      consoleOutputPath,
      state.consoleMessages.join("\n"),
    );
  }
}

await celestial.Runtime.enable();
console.log("profile: runtime enabled");
await celestial.Console.enable();
await celestial.Debugger.enable();
await celestial.Profiler.enable();
await celestial.Profiler.setSamplingInterval({ interval: 100 });

await celestial.Runtime.runIfWaitingForDebugger();
await celestial.Debugger.resume().catch(() => {});
console.log("profile: resumed target");

if (state.sawProfileStart) {
  await startProfiler();
}

const started = performance.now();
while (performance.now() - started < timeoutMs) {
  if (stopReason) {
    await stopProfile(stopReason);
    console.log(`profile: ${stopReason}`);
    break;
  }
  if (state.sawProfileStart && !state.profilerActive) {
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

if (!profileEnded) {
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

await celestial.close();

console.log(
  JSON.stringify(
    {
      reason: stopReason,
      outputPath,
      consoleMessages: state.consoleMessages.length,
    },
    null,
    2,
  ),
);
