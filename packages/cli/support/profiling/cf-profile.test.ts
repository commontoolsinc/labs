import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { profileErrorOutputPath } from "./capture-deno-inspector-profile-lib.ts";
import {
  findInspectorWebSocketUrl,
  inspectWaitFlag,
  pickInspectPort,
} from "./cf-profile-lib.ts";

const decoder = new TextDecoder();

type ReleasePortResult =
  | { found: true; port: number }
  | { found: false };

async function readTextStream(
  stream: ReadableStream<Uint8Array> | null,
  onText?: (text: string) => void,
): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const streamDecoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = streamDecoder.decode(value, { stream: true });
      text += chunk;
      onText?.(text);
    }
    const tail = streamDecoder.decode();
    text += tail;
    onText?.(text);
    return text;
  } finally {
    reader.releaseLock();
  }
}

function findReleasePort(text: string): number | undefined {
  const match = text.match(/profile release port (\d+)/);
  if (!match) return undefined;
  return Number(match[1]);
}

async function stopChildProcess(
  child: Deno.ChildProcess | undefined,
  releasePort: number,
): Promise<Deno.CommandStatus | undefined> {
  if (!child) return undefined;
  const connection = await Deno.connect({
    hostname: "127.0.0.1",
    port: releasePort,
  });
  connection.close();
  return await child.status;
}

async function terminateChildProcess(
  child: Deno.ChildProcess | undefined,
): Promise<Deno.CommandStatus | undefined> {
  if (!child) return undefined;
  try {
    child.kill("SIGTERM");
  } catch {
    // Already exited.
  }
  return await child.status;
}

Deno.test("cf-profile captures a CPU profile for CLI help", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "cf-profile-test-" });
  try {
    const profilePath = join(tmpDir, "profile.cpuprofile");
    const consolePath = join(tmpDir, "profile.console.log");
    const metaPath = join(tmpDir, "profile.meta.json");
    const scriptPath = fromFileUrl(new URL("cf-profile.ts", import.meta.url));

    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        scriptPath,
        `--profile-output=${profilePath}`,
        "--help",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);

    assertEquals(result.code, 0, `${stdout}\n${stderr}`);
    assertStringIncludes(stdout, "cf-profile: CPU profile");
    assertStringIncludes(stdout, "Usage:");

    const profileInfo = await Deno.stat(profilePath);
    assert(profileInfo.size > 0);
    const consoleInfo = await Deno.stat(consolePath);
    assert(consoleInfo.size > 0);

    const meta = JSON.parse(await Deno.readTextFile(metaPath));
    assertEquals(meta.command, ["--help"]);
    assertEquals("profileDoneMarker" in meta, false);
    assertEquals(meta.cliStatus.success, true);
    assertEquals(meta.captureStatus.success, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("capture-deno-inspector-profile waits for profiler start before summary stop", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "profile-capture-test-" });
  let target: Deno.ChildProcess | undefined;
  try {
    const profilePath = join(tmpDir, "profile.cpuprofile");
    const consolePath = join(tmpDir, "profile.console.log");
    const targetPath = fromFileUrl(
      new URL("fixtures/profile-marker-target.ts", import.meta.url),
    );
    const capturePath = fromFileUrl(
      new URL("capture-deno-inspector-profile.ts", import.meta.url),
    );
    const inspectPort = pickInspectPort();

    target = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net=127.0.0.1",
        inspectWaitFlag("127.0.0.1", inspectPort),
        targetPath,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const inspectorUrl = Promise.withResolvers<string>();
    const releasePort = Promise.withResolvers<ReleasePortResult>();
    let inspectorUrlFound = false;
    let releasePortFound = false;
    const targetStdoutPromise = readTextStream(target.stdout);
    const targetStderrPromise = readTextStream(target.stderr, (text) => {
      const found = findInspectorWebSocketUrl(text);
      if (found && !inspectorUrlFound) {
        inspectorUrlFound = true;
        inspectorUrl.resolve(found);
      }
      const foundReleasePort = findReleasePort(text);
      if (foundReleasePort && !releasePortFound) {
        releasePortFound = true;
        releasePort.resolve({ found: true, port: foundReleasePort });
      }
    }).then((text) => {
      if (!inspectorUrlFound) {
        inspectorUrl.reject(new Error("Inspector WebSocket URL was not found"));
      }
      if (!releasePortFound) {
        releasePort.resolve({ found: false });
      }
      return text;
    });

    const captureOutput = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        capturePath,
        `--output=${profilePath}`,
        `--console-output=${consolePath}`,
        "--summary-pattern=profile stop",
        "--profile-start-pattern=profile start",
        `--websocket-url=${await inspectorUrl.promise}`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const release = captureOutput.code === 0
      ? await releasePort.promise
      : { found: false } as const;
    const targetStatus = release.found
      ? await stopChildProcess(target, release.port)
      : await terminateChildProcess(target);
    target = undefined;
    const targetStdout = await targetStdoutPromise;
    const targetStderr = await targetStderrPromise;

    const captureStdout = decoder.decode(captureOutput.stdout);
    const captureStderr = decoder.decode(captureOutput.stderr);
    const failureOutput =
      `${captureStdout}\n${captureStderr}\n${targetStdout}\n${targetStderr}`;

    assertEquals(captureOutput.code, 0, failureOutput);
    assertEquals(targetStatus?.success, true, failureOutput);
    assertStringIncludes(captureStdout, "profile: summary matched");
    assertStringIncludes(targetStdout, "profile start");
    assertStringIncludes(targetStdout, "profile stop");

    try {
      const profileInfo = await Deno.stat(profilePath);
      assert(profileInfo.size > 0);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      const stopError = await Deno.readTextFile(
        profileErrorOutputPath(profilePath),
      );
      assertStringIncludes(stopError, "Profiler.stop failed");
    }
    const consoleLog = await Deno.readTextFile(consolePath);
    assertStringIncludes(consoleLog, "profile start");
    assertStringIncludes(consoleLog, "profile stop");
  } finally {
    await terminateChildProcess(target);
    target = undefined;
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("capture-deno-inspector-profile starts from a console marker", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "profile-capture-test-" });
  let target: Deno.ChildProcess | undefined;
  try {
    const profilePath = join(tmpDir, "profile.cpuprofile");
    const consolePath = join(tmpDir, "profile.console.log");
    const targetPath = fromFileUrl(
      new URL("fixtures/profile-marker-target.ts", import.meta.url),
    );
    const capturePath = fromFileUrl(
      new URL("capture-deno-inspector-profile.ts", import.meta.url),
    );
    const inspectPort = pickInspectPort();

    target = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net=127.0.0.1",
        inspectWaitFlag("127.0.0.1", inspectPort),
        targetPath,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const inspectorUrl = Promise.withResolvers<string>();
    const releasePort = Promise.withResolvers<ReleasePortResult>();
    let inspectorUrlFound = false;
    let releasePortFound = false;
    const targetStdoutPromise = readTextStream(target.stdout);
    const targetStderrPromise = readTextStream(target.stderr, (text) => {
      const found = findInspectorWebSocketUrl(text);
      if (found && !inspectorUrlFound) {
        inspectorUrlFound = true;
        inspectorUrl.resolve(found);
      }
      const foundReleasePort = findReleasePort(text);
      if (foundReleasePort && !releasePortFound) {
        releasePortFound = true;
        releasePort.resolve({ found: true, port: foundReleasePort });
      }
    }).then((text) => {
      if (!inspectorUrlFound) {
        inspectorUrl.reject(new Error("Inspector WebSocket URL was not found"));
      }
      if (!releasePortFound) {
        releasePort.resolve({ found: false });
      }
      return text;
    });

    const captureOutput = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        capturePath,
        `--output=${profilePath}`,
        `--console-output=${consolePath}`,
        "--summary-pattern=(?!)",
        "--profile-start-pattern=profile start",
        "--profile-stop-pattern=profile stop",
        `--websocket-url=${await inspectorUrl.promise}`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const release = captureOutput.code === 0
      ? await releasePort.promise
      : { found: false } as const;
    const targetStatus = release.found
      ? await stopChildProcess(target, release.port)
      : await terminateChildProcess(target);
    target = undefined;
    const targetStdout = await targetStdoutPromise;
    const targetStderr = await targetStderrPromise;

    const captureStdout = decoder.decode(captureOutput.stdout);
    const captureStderr = decoder.decode(captureOutput.stderr);
    const failureOutput =
      `${captureStdout}\n${captureStderr}\n${targetStdout}\n${targetStderr}`;

    assertEquals(captureOutput.code, 0, failureOutput);
    assertEquals(targetStatus?.success, true, failureOutput);
    assertStringIncludes(captureStdout, "profile: profile stop matched");
    assertStringIncludes(targetStdout, "profile start");
    assertStringIncludes(targetStdout, "profile stop");

    try {
      const profileInfo = await Deno.stat(profilePath);
      assert(profileInfo.size > 0);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      const stopError = await Deno.readTextFile(
        profileErrorOutputPath(profilePath),
      );
      assertStringIncludes(stopError, "Profiler.stop failed");
    }
    const consoleLog = await Deno.readTextFile(consolePath);
    assertStringIncludes(consoleLog, "profile start");
    assertStringIncludes(consoleLog, "profile stop");
  } finally {
    await terminateChildProcess(target);
    await Deno.remove(tmpDir, { recursive: true });
  }
});
