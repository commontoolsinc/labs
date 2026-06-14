import { dirname, fromFileUrl, join, resolve } from "@std/path";

type ProfileOptions = {
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

const DEFAULT_SUMMARY_PATTERN = String.raw`\d+ passed, \d+ failed`;
const DISABLED_SUMMARY_PATTERN = String.raw`(?!)`;
const DEBUGGER_WAITING_MESSAGE = "Waiting for the debugger to disconnect...";
const DEFAULT_PROFILE_DONE_MARKER = "__cf_profile_done__";
const encoder = new TextEncoder();

function parseArgs(args: string[]): {
  options: ProfileOptions;
  cliArgs: string[];
} {
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

function slugify(parts: string[]): string {
  const joined = parts.join("-").replaceAll(/[^\w.-]+/g, "-");
  const collapsed = joined.replaceAll(/-+/g, "-").replace(/^-|-$/g, "");
  return collapsed.length > 0 ? collapsed.slice(0, 80) : "cf";
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

function escapeRegex(source: string): string {
  return source.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickInspectPort(requested?: number): number {
  if (requested !== undefined) {
    return requested;
  }
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
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

async function mirrorOutput(
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

const { options, cliArgs } = parseArgs(Deno.args);
if (cliArgs.length === 0) {
  throw new Error("cf-profile requires a Common Fabric CLI command");
}

const repoRoot = resolve(fromFileUrl(new URL("..", import.meta.url)));
const inspectPort = pickInspectPort(options.inspectPort);
const defaultOutputDir = join(
  repoRoot,
  "tmp",
  "cf-profile",
  `${timestamp()}-${slugify(cliArgs)}`,
);
const requestedOutputPath = options.outputPath
  ? resolve(Deno.cwd(), options.outputPath)
  : join(options.outputDir ?? defaultOutputDir, "profile.cpuprofile");
const cpuPath = requestedOutputPath.endsWith(".json")
  ? requestedOutputPath.replace(/\.json$/i, ".cpuprofile")
  : requestedOutputPath;
const profileStem = cpuPath.endsWith(".cpuprofile")
  ? cpuPath.slice(0, -".cpuprofile".length)
  : cpuPath;
const outputDir = dirname(cpuPath);
await Deno.mkdir(outputDir, { recursive: true });

const consolePath = `${profileStem}.console.log`;
const metaPath = `${profileStem}.meta.json`;
const summaryPattern = options.summaryPattern ??
  (cliArgs[0] === "test" ? DEFAULT_SUMMARY_PATTERN : DISABLED_SUMMARY_PATTERN);
const summaryRegex = new RegExp(summaryPattern);
const profileDoneMarker = Deno.env.get("CF_PROFILE_DONE_MARKER") ??
  DEFAULT_PROFILE_DONE_MARKER;
const profileStopPattern = options.profileStopPattern
  ? `(?:${options.profileStopPattern})|(?:${escapeRegex(profileDoneMarker)})`
  : escapeRegex(profileDoneMarker);
const targetUrlPattern = options.targetUrlPattern ?? "packages/cli/mod.ts";
const cliPath = join(repoRoot, "packages", "cli", "mod.ts");
const capturePath = join(
  repoRoot,
  "scripts",
  "capture-deno-inspector-profile.ts",
);

console.log(`cf-profile: writing CPU profile to ${cpuPath}`);

const cliCommand = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    `--inspect=127.0.0.1:${inspectPort}`,
    "--allow-net",
    "--allow-ffi",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    cliPath,
    ...cliArgs,
  ],
  cwd: Deno.cwd(),
  env: {
    ...Deno.env.toObject(),
    CF_PROFILE_DONE_MARKER: profileDoneMarker,
  },
  stdin: "inherit",
  stdout: "piped",
  stderr: "piped",
}).spawn();

const captureArgs = [
  "run",
  "-A",
  capturePath,
  `--output=${cpuPath}`,
  `--console-output=${consolePath}`,
  `--summary-pattern=${summaryPattern}`,
  `--target-url-pattern=${targetUrlPattern}`,
  `--port=${inspectPort}`,
  `--timeout=${options.timeoutMs}`,
  `--connect-timeout=${options.connectTimeoutMs}`,
];
if (options.profileStartPattern) {
  captureArgs.push(`--profile-start-pattern=${options.profileStartPattern}`);
}
captureArgs.push(`--profile-stop-pattern=${profileStopPattern}`);

const capture = new Deno.Command(Deno.execPath(), {
  args: captureArgs,
  cwd: Deno.cwd(),
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

let captureStopSent = false;
let recentOutput = "";
const stopCapture = () => {
  if (captureStopSent) return;
  captureStopSent = true;
  try {
    capture.kill("SIGINT");
  } catch {
    // Already exited.
  }
};

const onCliOutput = (text: string) => {
  recentOutput = (recentOutput + text).slice(-8192);
  if (
    recentOutput.includes(profileDoneMarker) ||
    recentOutput.includes(DEBUGGER_WAITING_MESSAGE) ||
    summaryRegex.test(recentOutput)
  ) {
    stopCapture();
  }
};
const stdoutDone = mirrorOutput(
  cliCommand.stdout,
  Deno.stdout,
  onCliOutput,
);
const stderrDone = mirrorOutput(
  cliCommand.stderr,
  Deno.stderr,
  onCliOutput,
);

const captureStatusPromise = (async () => {
  const status = await capture.status;
  captureStopSent = true;
  return status;
})();
const cliStatus = await cliCommand.status;
await Promise.all([stdoutDone, stderrDone]);
if (!captureStopSent) {
  stopCapture();
}
const captureStatus = await captureStatusPromise;

await Deno.writeTextFile(
  metaPath,
  JSON.stringify(
    {
      command: cliArgs,
      cwd: Deno.cwd(),
      outputDir,
      cpuPath,
      consolePath,
      summaryPattern,
      profileStartPattern: options.profileStartPattern,
      profileStopPattern,
      profileDoneMarker,
      targetUrlPattern,
      inspectPort,
      cliStatus,
      captureStatus,
    },
    null,
    2,
  ),
);

console.log(`cf-profile: CPU profile ${cpuPath}`);
console.log(`cf-profile: console log ${consolePath}`);
console.log(`cf-profile: metadata ${metaPath}`);

if (!captureStatus.success) {
  Deno.exit(captureStatus.code);
}
if (!cliStatus.success) {
  Deno.exit(cliStatus.code);
}
