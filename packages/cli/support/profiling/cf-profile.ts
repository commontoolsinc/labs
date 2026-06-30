import { dirname, fromFileUrl, join, resolve } from "@std/path";
import {
  DEBUGGER_WAITING_MESSAGE,
  DEFAULT_PROFILE_DONE_MARKER,
  DEFAULT_SUMMARY_PATTERN,
  DISABLED_SUMMARY_PATTERN,
  escapeRegex,
  mirrorOutput,
  parseProfileArgs,
  pickInspectPort,
  profileTimestamp,
  slugifyProfileName,
  stopCaptureOnce,
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
const summaryRegex = new RegExp(summaryPattern);
const profileDoneMarker = Deno.env.get("CF_PROFILE_DONE_MARKER") ??
  DEFAULT_PROFILE_DONE_MARKER;
const profileStopPattern = options.profileStopPattern
  ? `(?:${options.profileStopPattern})|(?:${escapeRegex(profileDoneMarker)})`
  : escapeRegex(profileDoneMarker);
const targetUrlPattern = options.targetUrlPattern ?? "packages/cli/mod.ts";
const cliPath = join(repoRoot, "packages", "cli", "mod.ts");
const capturePath = join(
  profilingDir,
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

const captureStopState = { sent: false };
let recentOutput = "";
const stopCapture = () => {
  stopCaptureOnce(captureStopState, capture);
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
  captureStopState.sent = true;
  return status;
})();
const cliStatus = await cliCommand.status;
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
