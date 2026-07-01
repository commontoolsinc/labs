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
  profilerStarting: boolean;
  sawProfileStart: boolean;
  sawProfileStop: boolean;
};

export type ProfileStopState = {
  ended: boolean;
  reason?: string;
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

type InspectorCommandSocket = Pick<WebSocket, "readyState" | "send">;

export function sendInspectorCommand(
  ws: InspectorCommandSocket,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ id, method, params }));
  return true;
}

export function resumeDebuggerOnPause(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  ws: InspectorCommandSocket,
  id: number,
): () => void {
  const stopListening = () => {
    target.removeEventListener("Debugger.paused", handlePaused);
  };
  const handlePaused = () => {
    stopListening();
    sendInspectorCommand(ws, id, "Debugger.resume");
  };

  target.addEventListener("Debugger.paused", handlePaused);
  return stopListening;
}

export function parseArg(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

export function requireArg(args: string[], name: string): string {
  const value = parseArg(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.reject(new Error("WebSocket closed before opening"));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleClose);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (event: Event) => {
      cleanup();
      reject(event);
    };
    const handleClose = (event: CloseEvent) => {
      cleanup();
      reject(event);
    };

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("error", handleError);
    ws.addEventListener("close", handleClose);
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

export function recordConsoleProfileMessage(
  state: ProfileCaptureState,
  text: string,
  profileStartRegex?: RegExp,
  profileStopRegex?: RegExp,
): { startedProfile: boolean; hadProfileStop: boolean } {
  const hadProfileStart = state.sawProfileStart;
  const hadProfileStop = state.sawProfileStop;
  state.consoleMessages.push(text);
  if (profileStartRegex?.test(text)) {
    state.sawProfileStart = true;
  }
  if (profileStopRegex?.test(text)) {
    state.sawProfileStop = true;
  }
  return {
    startedProfile: !hadProfileStart && state.sawProfileStart,
    hadProfileStop,
  };
}

export function markProfilerStarted(
  state: ProfileCaptureState,
  options: { clearStop?: boolean } = {},
): void {
  state.profilerActive = true;
  state.profilerStarting = false;
  if (options.clearStop ?? true) {
    state.sawProfileStop = false;
  }
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
  options: { clearStop?: boolean } = {},
): Promise<boolean> {
  if (
    state.profilerActive || state.profilerStarting ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return false;
  }
  state.profilerStarting = true;
  try {
    await profiler.start();
    markProfilerStarted(state, options);
    log("profile: profiler started");
    return true;
  } finally {
    state.profilerStarting = false;
  }
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
