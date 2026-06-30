export type ProfileOptions = {
  outputPath?: string;
  outputDir?: string;
  summaryPattern?: string;
  profileStartPattern?: string;
  profileStopPattern?: string;
  targetUrlPattern?: string;
  inspectPort?: number;
  timeoutMs: number;
  connectTimeoutMs: number;
};

export type ParsedProfileArgs = {
  options: ProfileOptions;
  cliArgs: string[];
};

export type CaptureStopState = {
  sent: boolean;
};

type CommandStatus = Deno.CommandStatus;

type KillableProcess = {
  kill(signal: Deno.Signal): void;
};

type InspectPortListener = {
  addr: Deno.Addr;
  close(): void;
};

type ListenForInspectPort = (
  options: { hostname: string; port: number },
) => InspectPortListener;

export const DEFAULT_SUMMARY_PATTERN = String.raw`\d+ passed, \d+ failed`;
export const DISABLED_SUMMARY_PATTERN = String.raw`(?!)`;
export const DEBUGGER_WAITING_MESSAGE =
  "Waiting for the debugger to disconnect...";
export const DEFAULT_PROFILE_DONE_MARKER = "__cf_profile_done__";

const encoder = new TextEncoder();

export function inspectWaitFlag(host: string, port: number): string {
  return `--inspect-wait=${host}:${port}`;
}

export function parseProfileArgs(args: string[]): ParsedProfileArgs {
  const options: ProfileOptions = {
    timeoutMs: 120_000,
    connectTimeoutMs: 30_000,
  };
  const cliArgs: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--profile-output=")) {
      options.outputPath = arg.slice("--profile-output=".length);
    } else if (arg.startsWith("--profile-dir=")) {
      options.outputDir = arg.slice("--profile-dir=".length);
    } else if (arg.startsWith("--profile-summary-pattern=")) {
      options.summaryPattern = arg.slice("--profile-summary-pattern=".length);
    } else if (arg.startsWith("--profile-start-pattern=")) {
      options.profileStartPattern = arg.slice(
        "--profile-start-pattern=".length,
      );
    } else if (arg.startsWith("--profile-stop-pattern=")) {
      options.profileStopPattern = arg.slice("--profile-stop-pattern=".length);
    } else if (arg.startsWith("--profile-target-url-pattern=")) {
      options.targetUrlPattern = arg.slice(
        "--profile-target-url-pattern=".length,
      );
    } else if (arg.startsWith("--profile-inspect-port=")) {
      options.inspectPort = Number(arg.slice("--profile-inspect-port=".length));
    } else if (arg.startsWith("--profile-timeout-ms=")) {
      options.timeoutMs = Number(arg.slice("--profile-timeout-ms=".length));
    } else if (arg.startsWith("--profile-connect-timeout-ms=")) {
      options.connectTimeoutMs = Number(
        arg.slice("--profile-connect-timeout-ms=".length),
      );
    } else {
      cliArgs.push(arg);
    }
  }

  if (
    options.outputPath !== undefined && options.outputDir !== undefined
  ) {
    throw new Error("Pass either --profile-output or --profile-dir, not both");
  }
  if (
    options.inspectPort !== undefined &&
    (!Number.isFinite(options.inspectPort) || options.inspectPort <= 0)
  ) {
    throw new Error("--profile-inspect-port must be a positive number");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error("--profile-timeout-ms must be a non-negative number");
  }
  if (
    !Number.isFinite(options.connectTimeoutMs) || options.connectTimeoutMs < 0
  ) {
    throw new Error(
      "--profile-connect-timeout-ms must be a non-negative number",
    );
  }

  return { options, cliArgs };
}

export function slugifyProfileName(parts: string[]): string {
  const joined = parts.join("-").replaceAll(/[^\w.-]+/g, "-");
  const collapsed = joined.replaceAll(/-+/g, "-").replace(/^-|-$/g, "");
  return collapsed.length > 0 ? collapsed.slice(0, 80) : "cf";
}

export function profileTimestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

export function escapeRegex(source: string): string {
  return source.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pickInspectPort(
  requested?: number,
  listen: ListenForInspectPort = Deno.listen,
): number {
  if (requested !== undefined) {
    return requested;
  }
  const listener = listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const address = listener.addr;
    if (address.transport !== "tcp") {
      throw new Error("Expected a TCP listener while allocating inspect port");
    }
    return address.port;
  } finally {
    listener.close();
  }
}

export function stopCaptureOnce(
  state: CaptureStopState,
  capture: KillableProcess,
  signal: Deno.Signal = "SIGINT",
): void {
  if (state.sent) return;
  state.sent = true;
  try {
    capture.kill(signal);
  } catch {
    // Already exited.
  }
}

export async function waitForCliStatusOrStopOnCaptureFailure(
  cliStatusPromise: Promise<CommandStatus>,
  captureStatusPromise: Promise<CommandStatus>,
  cliStopState: CaptureStopState,
  cliProcess: KillableProcess,
): Promise<CommandStatus> {
  const firstStatus = await Promise.race([
    cliStatusPromise.then((status) => ({ kind: "cli" as const, status })),
    captureStatusPromise.then((status) => ({
      kind: "capture" as const,
      status,
    })),
  ]);

  if (firstStatus.kind === "cli") return firstStatus.status;
  if (!firstStatus.status.success) {
    stopCaptureOnce(cliStopState, cliProcess, "SIGTERM");
  }
  return await cliStatusPromise;
}

export async function mirrorOutput(
  stream: ReadableStream<Uint8Array> | null,
  sink: { write(data: Uint8Array): Promise<number> | number },
  onText?: (text: string) => void,
): Promise<void> {
  if (stream === null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length === 0) continue;
      const text = decoder.decode(value, { stream: true });
      if (text.length === 0) continue;
      onText?.(text);
      await sink.write(encoder.encode(text));
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      onText?.(tail);
      await sink.write(encoder.encode(tail));
    }
  } finally {
    reader.releaseLock();
  }
}
