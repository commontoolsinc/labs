import { dirname } from "@std/path";

export type InspectorTarget = {
  description?: string;
  id: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl: string;
};

export type ProfileCaptureState = {
  consoleMessages: string[];
  profilerActive: boolean;
  sawProfileStart: boolean;
  sawProfileStop: boolean;
};

export type ProfileStopState = {
  ended: boolean;
  reason?: string;
};

type TargetListResponse = {
  ok: boolean;
  json(): Promise<InspectorTarget[]>;
};

type WaitForTargetDependencies = {
  fetchFn?: (input: string) => Promise<TargetListResponse>;
  now?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
};

type ProfilerController = {
  start(): Promise<void>;
  stop(): Promise<{ profile: unknown }>;
};

type ProfileFileWriter = {
  mkdir(
    path: string,
    options: { recursive: boolean },
  ): Promise<unknown>;
  writeTextFile(path: string, data: string): Promise<unknown>;
};

type ProfileWriteOptions = {
  outputPath: string;
  consoleOutputPath?: string;
  state: ProfileCaptureState;
  profile: unknown;
  stopError?: string;
  writer?: ProfileFileWriter;
};

export function parseArg(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

export function parseNumberArg(
  args: string[],
  name: string,
  defaultValue: number,
): number {
  const raw = parseArg(args, name);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return Math.floor(value);
}

export function requireArg(args: string[], name: string): string {
  const value = parseArg(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
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

export function stringifyRemoteObject(value: Record<string, unknown>): string {
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

export async function waitForTarget(
  host: string,
  port: number,
  timeoutMs: number,
  targetUrlPattern?: RegExp,
  dependencies: WaitForTargetDependencies = {},
): Promise<InspectorTarget> {
  const fetchFn: (input: string) => Promise<TargetListResponse> =
    dependencies.fetchFn ?? fetch;
  const now = dependencies.now ?? (() => performance.now());
  const sleepMs = dependencies.sleepMs ?? sleep;
  const started = now();
  const endpoint = `http://${host}:${port}/json/list`;

  while (now() - started < timeoutMs) {
    try {
      const response = await fetchFn(endpoint);
      if (response.ok) {
        const targets = await response.json();
        const match = targets.find((target) =>
          target.type === "node" &&
          (!targetUrlPattern || targetUrlPattern.test(target.url ?? ""))
        );
        if (match) return match;
      }
    } catch {
      // Retry until timeout.
    }
    await sleepMs(100);
  }

  throw new Error(`Timed out waiting for inspector target at ${endpoint}`);
}

export function recordConsoleProfileMessage(
  state: ProfileCaptureState,
  text: string,
  profileStartRegex?: RegExp,
  profileStopRegex?: RegExp,
): void {
  state.consoleMessages.push(text);
  if (profileStartRegex?.test(text)) {
    state.sawProfileStart = true;
  }
  if (profileStopRegex?.test(text)) {
    state.sawProfileStop = true;
  }
}

export function markProfilerStarted(state: ProfileCaptureState): void {
  state.profilerActive = true;
  state.sawProfileStop = false;
}

export function markProfileStoppedOnce(
  state: ProfileStopState,
  reason: string,
): boolean {
  if (state.ended) return false;
  state.ended = true;
  state.reason ??= reason;
  return true;
}

export async function startProfilerIfReady(
  state: ProfileCaptureState,
  ws: Pick<WebSocket, "readyState">,
  profiler: Pick<ProfilerController, "start">,
  log: (message: string) => void = () => {},
): Promise<boolean> {
  if (state.profilerActive || ws.readyState !== WebSocket.OPEN) return false;
  await profiler.start();
  markProfilerStarted(state);
  log("profile: profiler started");
  return true;
}

export async function stopActiveProfiler(
  state: ProfileCaptureState,
  ws: Pick<WebSocket, "readyState">,
  profiler: Pick<ProfilerController, "stop">,
): Promise<{ profile: unknown; stopError?: string }> {
  let profile: unknown = null;
  let stopError: string | undefined;
  if (state.profilerActive && ws.readyState === WebSocket.OPEN) {
    try {
      profile = (await profiler.stop()).profile;
      state.profilerActive = false;
    } catch (error) {
      stopError = `Profiler.stop failed: ${error}`;
    }
  }

  return { profile, stopError };
}

export function profileErrorOutputPath(outputPath: string): string {
  return outputPath.endsWith(".cpuprofile")
    ? outputPath.replace(/\.cpuprofile$/i, ".error.txt")
    : `${outputPath}.error.txt`;
}

export async function writeProfileCaptureFiles(
  options: ProfileWriteOptions,
): Promise<void> {
  const writer = options.writer ?? Deno;
  await writer.mkdir(dirname(options.outputPath), { recursive: true }).catch(
    () => {},
  );
  if (options.profile) {
    await writer.writeTextFile(
      options.outputPath,
      JSON.stringify(options.profile, null, 2),
    );
  } else if (options.stopError) {
    await writer.writeTextFile(
      profileErrorOutputPath(options.outputPath),
      options.stopError,
    );
  }

  if (options.consoleOutputPath) {
    await writer.writeTextFile(
      options.consoleOutputPath,
      options.state.consoleMessages.join("\n"),
    );
  }
}
