import { assertEquals, assertStringIncludes } from "@std/assert";

import {
  BACKGROUND_LOG_ENV,
  buildBackgroundChildCommand,
  classifyLaunch,
  READY_MARKER,
  runBackgroundParent,
  type SpawnedChild,
} from "@/background.ts";

// A ReadableStream that emits the given text chunks and then closes, standing in
// for a spawned child's stdout.
function stdoutOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

Deno.test("classifyLaunch separates control flags from server args", () => {
  const foreground = classifyLaunch(["--port=8002"]);
  assertEquals(foreground.background, false);
  assertEquals(foreground.logFile, undefined);
  assertEquals(foreground.serverArgs, ["--port=8002"]);

  const parent = classifyLaunch([
    "--port=8002",
    "--background",
    "--log-file=/tmp/toolshed.log",
  ]);
  assertEquals(parent.background, true);
  assertEquals(parent.logFile, "/tmp/toolshed.log");
  assertEquals(parent.serverArgs, ["--port=8002"]);
});

Deno.test("buildBackgroundChildCommand re-runs the compiled binary directly", () => {
  const { command, args } = buildBackgroundChildCommand({
    execPath: "/opt/common-binaries/toolshed",
    mainModule: "file:///proj/packages/toolshed/index.ts",
    serverArgs: ["--port=8002"],
  });
  assertEquals(command, "/opt/common-binaries/toolshed");
  // Only the server's own arguments: the child is marked through the
  // environment, not the command line.
  assertEquals(args, ["--port=8002"]);
});

Deno.test("buildBackgroundChildCommand re-runs deno against the entry module", () => {
  const { command, args } = buildBackgroundChildCommand({
    execPath: "/usr/local/bin/deno",
    mainModule: "file:///proj/packages/toolshed/index.ts",
    serverArgs: ["--port=8002"],
  });
  assertEquals(command, "/usr/local/bin/deno");
  assertEquals(args, [
    "run",
    "--unstable-otel",
    "-A",
    "/proj/packages/toolshed/index.ts",
    "--port=8002",
  ]);
});

Deno.test("runBackgroundParent marks the child through the environment", async () => {
  let seenEnv: Record<string, string> | undefined;
  const child: SpawnedChild = {
    pid: 4321,
    stdout: stdoutOf([`${READY_MARKER}\n`]),
    status: new Promise<Deno.CommandStatus>(() => {}),
    unref: () => {},
  };

  await runBackgroundParent(
    {
      execPath: "/opt/common-binaries/toolshed",
      mainModule: "file:///proj/index.ts",
      serverArgs: ["--port=8002"],
      logFile: "/tmp/toolshed.log",
    },
    {
      spawn: (_command, _args, env) => {
        seenEnv = env;
        return child;
      },
      exit: () => {},
      writeOut: () => {},
      writeErr: () => {},
      readLog: () => Promise.resolve(""),
    },
  );

  assertEquals(seenEnv?.[BACKGROUND_LOG_ENV], "/tmp/toolshed.log");
});

Deno.test("runBackgroundParent detaches and exits 0 once the child is listening", async () => {
  let unrefed = false;
  let exitCode: number | undefined;
  const out: string[] = [];
  const child: SpawnedChild = {
    pid: 4321,
    stdout: stdoutOf([`${READY_MARKER}\n`]),
    // A listening child stays up, so its status never resolves during the wait.
    status: new Promise<Deno.CommandStatus>(() => {}),
    unref: () => {
      unrefed = true;
    },
  };

  await runBackgroundParent(
    {
      execPath: "/opt/common-binaries/toolshed",
      mainModule: "file:///proj/index.ts",
      serverArgs: ["--port=8002"],
      logFile: "/tmp/toolshed.log",
    },
    {
      spawn: () => child,
      exit: (code) => {
        exitCode = code;
      },
      writeOut: (line) => out.push(line),
      writeErr: () => {},
      readLog: () => Promise.resolve(""),
    },
  );

  assertEquals(unrefed, true);
  assertEquals(exitCode, 0);
  assertStringIncludes(out.join("\n"), "pid 4321");
});

Deno.test("runBackgroundParent surfaces the log and the code when the child dies first", async () => {
  let unrefed = false;
  let exitCode: number | undefined;
  const errs: string[] = [];
  const child: SpawnedChild = {
    pid: 4321,
    // stdout closes without ever emitting the marker: the child exited early.
    stdout: stdoutOf(["Server is starting on port http://0.0.0.0:8002\n"]),
    status: Promise.resolve({ success: false, code: 3, signal: null }),
    unref: () => {
      unrefed = true;
    },
  };

  await runBackgroundParent(
    {
      execPath: "/opt/common-binaries/toolshed",
      mainModule: "file:///proj/index.ts",
      serverArgs: ["--port=8002"],
      logFile: "/tmp/toolshed.log",
    },
    {
      spawn: () => child,
      exit: (code) => {
        exitCode = code;
      },
      writeOut: () => {},
      writeErr: (line) => errs.push(line),
      readLog: () => Promise.resolve("Port 8002 is already in use"),
    },
  );

  assertEquals(unrefed, false);
  assertEquals(exitCode, 3);
  const text = errs.join("\n");
  assertStringIncludes(text, "exited with code 3");
  assertStringIncludes(text, "Port 8002 is already in use");
});
