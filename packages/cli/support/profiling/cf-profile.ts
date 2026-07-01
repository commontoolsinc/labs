import { dirname, fromFileUrl, join, resolve } from "@std/path";
import {
  DEBUGGER_WAITING_MESSAGE,
  DEFAULT_SUMMARY_PATTERN,
  DISABLED_SUMMARY_PATTERN,
  findInspectorWebSocketUrl,
  inspectWaitFlag,
  mirrorOutput,
  parseProfileArgs,
  pickInspectPort,
  profileTimestamp,
  slugifyProfileName,
  stopCaptureOnce,
  waitForCliStatusOrStopOnCaptureFailure,
} from "./cf-profile-lib.ts";

const { options, cliArgs } = parseProfileArgs(Deno.args);
if (cliArgs.length === 0) {
  throw new Error("cf-profile requires a Common Fabric CLI command");
}

const profilingDir = dirname(fromFileUrl(import.meta.url));
const repoRoot = resolve(profilingDir, "../../../..");
const inspectPort = pickInspectPort(options.inspectPort);
const defaultOutputDir = join(
  repoRoot,
  "tmp",
  "cf-profile",
  `${profileTimestamp()}-${slugifyProfileName(cliArgs)}`,
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
const profileStopPattern = options.profileStopPattern;
const cliPath = join(repoRoot, "packages", "cli", "mod.ts");
const capturePath = join(
  profilingDir,
  "capture-deno-inspector-profile.ts",
);

console.log(`cf-profile: writing CPU profile to ${cpuPath}`);

const cliCommand = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    inspectWaitFlag("127.0.0.1", inspectPort),
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
  env: Deno.env.toObject(),
  stdin: "inherit",
  stdout: "piped",
  stderr: "piped",
}).spawn();

const captureStopState = { sent: false };
const inspectorUrl = Promise.withResolvers<string>();
const cliStatusPromise = cliCommand.status;
let recentOutput = "";
let inspectorUrlFound = false;
let capture: Deno.ChildProcess | undefined;
const stopCapture = () => {
  if (capture) {
    stopCaptureOnce(captureStopState, capture);
  }
};

const onCliOutput = (text: string) => {
  recentOutput = (recentOutput + text).slice(-8192);
  const foundInspectorUrl = findInspectorWebSocketUrl(recentOutput);
  if (foundInspectorUrl && !inspectorUrlFound) {
    inspectorUrlFound = true;
    inspectorUrl.resolve(foundInspectorUrl);
  }
  if (recentOutput.includes(DEBUGGER_WAITING_MESSAGE)) {
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

const inspectorUrlResult = await Promise.race([
  inspectorUrl.promise.then((url) => ({ kind: "inspector-url" as const, url })),
  cliStatusPromise.then((status) => ({ kind: "cli-status" as const, status })),
]);

if (inspectorUrlResult.kind === "cli-status") {
  await Promise.all([stdoutDone, stderrDone]);
  Deno.exit(inspectorUrlResult.status.code);
}

const captureArgs = [
  "run",
  "-A",
  capturePath,
  `--output=${cpuPath}`,
  `--console-output=${consolePath}`,
  `--summary-pattern=${summaryPattern}`,
  `--websocket-url=${inspectorUrlResult.url}`,
];
if (options.profileStartPattern) {
  captureArgs.push(`--profile-start-pattern=${options.profileStartPattern}`);
}
if (profileStopPattern) {
  captureArgs.push(`--profile-stop-pattern=${profileStopPattern}`);
}

capture = new Deno.Command(Deno.execPath(), {
  args: captureArgs,
  cwd: Deno.cwd(),
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

const captureStatusPromise = (async () => {
  if (!capture) {
    throw new Error("Capture process was not started");
  }
  const status = await capture.status;
  captureStopState.sent = true;
  return status;
})();
const cliStopState = { sent: false };
const cliStatus = await waitForCliStatusOrStopOnCaptureFailure(
  cliStatusPromise,
  captureStatusPromise,
  cliStopState,
  cliCommand,
);
await Promise.all([stdoutDone, stderrDone]);
if (!captureStopState.sent) {
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
