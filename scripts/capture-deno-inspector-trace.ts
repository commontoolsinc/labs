import { Celestial } from "../packages/vendor-astral/bindings/celestial.ts";
import { dirname } from "@std/path";

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
const cpuOutputPath = parseArg("cpu-output") ??
  outputPath.replace(/\.json$/i, ".cpuprofile");
const consoleOutputPath = parseArg("console-output");
const summaryPattern = parseArg("summary-pattern") ??
  "\\d+ passed, \\d+ failed";
const targetUrlPattern = parseArg("target-url-pattern");
const connectTimeoutMs = parseNumberArg("connect-timeout", 30_000);
const timeoutMs = parseNumberArg("timeout", 120_000);
const categories = parseArg("categories") ??
  [
    "devtools.timeline",
    "disabled-by-default-v8.cpu_profiler",
    "disabled-by-default-v8.runtime_stats",
    "v8.execute",
    "blink.user_timing",
  ].join(",");

const target = await waitForTarget(
  host,
  port,
  connectTimeoutMs,
  targetUrlPattern ? new RegExp(targetUrlPattern) : undefined,
);
console.log(`trace: target ${target.title ?? target.id}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await waitForWebSocketOpen(ws);
console.log("trace: websocket open");

const celestial = new Celestial(ws);
const traceEvents: object[] = [];
const consoleMessages: string[] = [];
const summaryRegex = new RegExp(summaryPattern);
let traceEnded = false;

const tracingComplete = Promise.withResolvers<{
  dataLossOccurred: boolean;
  stream?: string;
  traceFormat?: string;
  streamCompression?: string;
}>();

celestial.addEventListener("Tracing.dataCollected", (event) => {
  traceEvents.push(...event.detail.value);
});

celestial.addEventListener("Tracing.tracingComplete", (event) => {
  tracingComplete.resolve(event.detail);
});

celestial.addEventListener("Runtime.consoleAPICalled", (event) => {
  const text = event.detail.args
    .map((arg) => stringifyRemoteObject(arg as Record<string, unknown>))
    .join(" ");
  consoleMessages.push(text);
});

async function stopTrace(reason: string) {
  if (traceEnded) return;
  traceEnded = true;

  let profile: unknown = null;
  let stopError: string | undefined;
  if (ws.readyState === WebSocket.OPEN) {
    try {
      profile = (await celestial.Profiler.stop()).profile;
    } catch (error) {
      stopError = `Profiler.stop failed: ${error}`;
    }
  }

  await Deno.mkdir(dirname(outputPath), { recursive: true }).catch(() => {});
  await Deno.mkdir(dirname(cpuOutputPath), { recursive: true }).catch(() => {});
  if (profile) {
    await Deno.writeTextFile(cpuOutputPath, JSON.stringify(profile, null, 2));
  }

  if (ws.readyState === WebSocket.OPEN) {
    try {
      await celestial.Tracing.end();
    } catch (error) {
      stopError = `${
        stopError ? `${stopError}; ` : ""
      }Tracing.end failed: ${error}`;
    }
  }
  const complete = await Promise.race([
    tracingComplete.promise,
    sleep(5_000).then(() => ({
      dataLossOccurred: false,
    })),
  ]);

  await Deno.writeTextFile(
    outputPath,
    JSON.stringify(
      {
        traceEvents,
        metadata: {
          reason,
          host,
          port,
          categories,
          target,
          consoleMessages,
          stopError,
          tracingComplete: complete,
        },
      },
      null,
      2,
    ),
  );

  if (consoleOutputPath) {
    await Deno.writeTextFile(consoleOutputPath, consoleMessages.join("\n"));
  }
}

await celestial.Runtime.enable();
console.log("trace: runtime enabled");
await celestial.Console.enable();
await celestial.Debugger.enable();
await celestial.Profiler.enable();
await celestial.Profiler.setSamplingInterval({ interval: 100 });
await celestial.Profiler.start();
console.log("trace: profiler started");
await celestial.Tracing.start({
  categories,
  transferMode: "ReportEvents",
  streamCompression: "none",
});
console.log("trace: tracing started");

await celestial.Runtime.runIfWaitingForDebugger();
await celestial.Debugger.resume().catch(() => {});
console.log("trace: resumed target");

const started = performance.now();
while (performance.now() - started < timeoutMs) {
  if (consoleMessages.some((message) => summaryRegex.test(message))) {
    await stopTrace("summary-matched");
    console.log("trace: summary matched");
    break;
  }
  if (ws.readyState === WebSocket.CLOSED) {
    await stopTrace("websocket-closed");
    console.log("trace: websocket closed");
    break;
  }
  await sleep(100);
}

if (!traceEnded) {
  await stopTrace("timeout");
  console.log("trace: timeout");
}

await celestial.close();

console.log(
  JSON.stringify(
    {
      outputPath,
      cpuOutputPath,
      eventCount: traceEvents.length,
      consoleMessages: consoleMessages.length,
    },
    null,
    2,
  ),
);
