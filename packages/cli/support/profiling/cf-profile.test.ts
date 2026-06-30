import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { profileErrorOutputPath } from "./capture-deno-inspector-profile-lib.ts";
import { inspectWaitFlag, pickInspectPort } from "./cf-profile-lib.ts";

const decoder = new TextDecoder();

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout();
          } catch {
            // The process may have exited between the timeout and cleanup.
          }
          reject(new Error(`Timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
    assertEquals(meta.cliStatus.success, true);
    assertEquals(meta.captureStatus.success, true);
  } finally {
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
        inspectWaitFlag("127.0.0.1", inspectPort),
        targetPath,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const targetOutputPromise = target.output();

    const captureOutput = await withTimeout(
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          capturePath,
          `--output=${profilePath}`,
          `--console-output=${consolePath}`,
          "--summary-pattern=(?!)",
          "--profile-start-pattern=profile start",
          "--profile-stop-pattern=profile stop",
          "--target-url-pattern=profile-marker-target\\.ts$",
          `--port=${inspectPort}`,
          "--timeout=5000",
          "--connect-timeout=5000",
        ],
        stdout: "piped",
        stderr: "piped",
      }).output(),
      30_000,
      () => target?.kill("SIGTERM"),
    );
    const targetOutput = await withTimeout(
      targetOutputPromise,
      30_000,
      () => target?.kill("SIGTERM"),
    );

    const captureStdout = decoder.decode(captureOutput.stdout);
    const captureStderr = decoder.decode(captureOutput.stderr);
    const targetStdout = decoder.decode(targetOutput.stdout);
    const targetStderr = decoder.decode(targetOutput.stderr);

    assertEquals(captureOutput.code, 0, `${captureStdout}\n${captureStderr}`);
    assertEquals(targetOutput.code, 0, `${targetStdout}\n${targetStderr}`);
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
    try {
      target?.kill("SIGTERM");
    } catch {
      // Already exited.
    }
    await Deno.remove(tmpDir, { recursive: true });
  }
});
