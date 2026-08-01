import { assertEquals, assertRejects } from "@std/assert";
import { runDashboardTests, TEST_COMMANDS } from "./test/runner.ts";

Deno.test("dashboard test runner isolates caches and stops after a failure", async () => {
  const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
  const removed: string[] = [];
  const code = await runDashboardTests({
    interrupts: [],
    makeTempDirectory: () => Promise.resolve("dashboard-test-cache"),
    removeDirectory: (directory) => {
      removed.push(directory);
      return Promise.resolve();
    },
    spawn: (args, env) => {
      calls.push({ args, env });
      return {
        status: Promise.resolve({ code: calls.length === 2 ? 7 : 0 }),
        kill: () => {},
      };
    },
  });

  assertEquals(code, 7);
  assertEquals(calls, [
    {
      args: TEST_COMMANDS[0],
      env: {
        TMPDIR: "dashboard-test-cache",
        DASHBOARD_CACHE_DIR: "dashboard-test-cache",
      },
    },
    {
      args: TEST_COMMANDS[1],
      env: {
        TMPDIR: "dashboard-test-cache",
        DASHBOARD_CACHE_DIR: "dashboard-test-cache",
      },
    },
  ]);
  assertEquals(removed, ["dashboard-test-cache"]);
});

Deno.test("dashboard test runner stops its child before interruption cleanup", async () => {
  const handlers = new Map<Deno.Signal, () => void>();
  const removed: string[] = [];
  const events: string[] = [];
  let finishChild: (status: { code: number }) => void = () => {};
  let childStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => childStarted = resolve);

  const result = runDashboardTests({
    interrupts: [{ signal: "SIGINT", status: 130 }],
    addSignalListener: (signal, handler) => handlers.set(signal, handler),
    removeSignalListener: (signal, handler) => {
      assertEquals(handlers.get(signal), handler);
      handlers.delete(signal);
    },
    makeTempDirectory: () => Promise.resolve("dashboard-test-cache"),
    removeDirectory: (directory) => {
      events.push("remove");
      removed.push(directory);
      return Promise.resolve();
    },
    spawn: () => {
      const status = new Promise<{ code: number }>((resolve) => {
        finishChild = resolve;
      });
      childStarted();
      return {
        status,
        kill: () => {
          events.push("kill");
          finishChild({ code: 143 });
        },
      };
    },
  });

  await started;
  handlers.get("SIGINT")!();
  assertEquals(await result, 130);
  assertEquals(events, ["kill", "remove"]);
  assertEquals(removed, ["dashboard-test-cache"]);
  assertEquals(handlers.size, 0);
});

Deno.test("dashboard test runner handles signals received before a child starts", async () => {
  let spawned = false;
  const result = await runDashboardTests({
    interrupts: [{ signal: "SIGINT", status: 130 }],
    addSignalListener: (_signal, handler) => handler(),
    removeSignalListener: () => {},
    makeTempDirectory: () => Promise.resolve("dashboard-test-cache"),
    removeDirectory: () => Promise.resolve(),
    spawn: () => {
      spawned = true;
      return { status: Promise.resolve({ code: 0 }), kill: () => {} };
    },
  });

  assertEquals(result, 130);
  assertEquals(spawned, false);
});

Deno.test("dashboard test runner gives an interrupt precedence over a child error", async () => {
  const handlers = new Map<Deno.Signal, () => void>();
  let rejectChild: (error: unknown) => void = () => {};
  let started: () => void = () => {};
  const childStarted = new Promise<void>((resolve) => started = resolve);
  const result = runDashboardTests({
    interrupts: [{ signal: "SIGTERM", status: 143 }],
    addSignalListener: (signal, handler) => handlers.set(signal, handler),
    removeSignalListener: () => {},
    makeTempDirectory: () => Promise.resolve("dashboard-test-cache"),
    removeDirectory: () => Promise.resolve(),
    spawn: () => {
      const status = new Promise<{ code: number }>((_resolve, reject) => {
        rejectChild = reject;
      });
      started();
      return {
        status,
        kill: () => {
          throw new Error("child already exited");
        },
      };
    },
  });

  await childStarted;
  handlers.get("SIGTERM")!();
  handlers.get("SIGTERM")!();
  rejectChild(new Error("child failed"));
  assertEquals(await result, 143);
});

Deno.test("dashboard test runner propagates a child process error", async () => {
  await assertRejects(
    () =>
      runDashboardTests({
        interrupts: [],
        makeTempDirectory: () => Promise.resolve("dashboard-test-cache"),
        removeDirectory: () => Promise.resolve(),
        spawn: () => ({
          status: Promise.reject(new Error("spawned process failed")),
          kill: () => {},
        }),
      }),
    Error,
    "spawned process failed",
  );
});

Deno.test("dashboard test runner completes every configured suite", async () => {
  const commands: string[][] = [];
  const result = await runDashboardTests({
    interrupts: [],
    makeTempDirectory: () => Promise.resolve("dashboard-test-cache"),
    removeDirectory: () => Promise.resolve(),
    spawn: (args) => {
      commands.push([...args]);
      return { status: Promise.resolve({ code: 0 }), kill: () => {} };
    },
  });

  assertEquals(result, 0);
  assertEquals(commands, TEST_COMMANDS.map((args) => [...args]));
});

Deno.test("dashboard browser tests disable the Chromium sandbox in CI", async () => {
  const previous = Deno.env.get("CI");
  try {
    Deno.env.set("CI", "1");
    const config = (await import("./deno-web-test.config.ts?ci-test")).default;
    assertEquals(config.args, ["--no-sandbox"]);
  } finally {
    if (previous === undefined) Deno.env.delete("CI");
    else Deno.env.set("CI", previous);
  }
});
