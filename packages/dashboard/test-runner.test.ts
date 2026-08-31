import { assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
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
      env: { DASHBOARD_CACHE_DIR: "dashboard-test-cache" },
    },
    {
      args: TEST_COMMANDS[1],
      env: { DASHBOARD_CACHE_DIR: "dashboard-test-cache" },
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
    // The config module reads CI as it loads, so the assertion needs a fresh
    // evaluation under the value just set.
    // deno-lint-ignore cf-imports/no-inline-module-import
    const config = (await import("./deno-web-test.config.ts?ci-test")).default;
    assertEquals(config.args, ["--no-sandbox"]);
  } finally {
    if (previous === undefined) Deno.env.delete("CI");
    else Deno.env.set("CI", previous);
  }
});

/**
 * The first half of the fixture standing in for a test command that leaves a
 * process running behind it. Run as `deno eval`, it starts the second half
 * with the script it is handed as an argument, and exits without waiting for
 * it.
 *
 * That is what the browser task does: it launches Chrome, and Chrome's crash
 * handler, zygote, and GPU processes are still running when the Deno process
 * that launched Chrome exits. The second half inherits the environment the
 * first half was given, which is how those helper processes come by whatever
 * temporary directory the dashboard test runner hands its commands.
 *
 * Both halves are inline scripts importing nothing, so the isolated-deno
 * lockfile helper does not apply: there is no module graph to freeze, and that
 * helper waits for the child to exit, which is the moment this test needs to
 * look at from the outside.
 */
const START_LEFTOVER_PROCESS = `
new Deno.Command(Deno.execPath(), {
  args: ["eval", Deno.args[0]],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn().unref();
`;

/**
 * The second half of that fixture. It writes `ready`, waits for a byte, writes
 * a file into the directory `TMPDIR` names, and reports that file as
 * `wrote <path>`.
 */
const LEFTOVER_PROCESS = `
const encoder = new TextEncoder();
await Deno.stdout.write(encoder.encode("ready\\n"));
if (await Deno.stdin.read(new Uint8Array(1)) === null) {
  throw new Error("Standard input closed before the cue arrived");
}
const directory = Deno.env.get("TMPDIR");
if (directory === undefined) throw new Error("TMPDIR names no directory");
const path = directory + "/leftover-process-file";
await Deno.writeTextFile(path, "");
await Deno.stdout.write(encoder.encode("wrote " + path + "\\n"));
`;

/**
 * Opens a conversation with the process the fixture leaves behind, over the
 * standard input and standard output that the command it outlived handed down
 * to it.
 */
function openLeftoverProcess(child: Deno.ChildProcess) {
  const reader = child.stdout.getReader();
  const writer = child.stdin.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";

  /**
   * Helper for `openLeftoverProcess()`, which returns the next line the
   * leftover process wrote, and throws where standard output ends first.
   */
  async function readLine(): Promise<string> {
    while (!pending.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error(
          `The leftover process ended after ${JSON.stringify(pending)}`,
        );
      }
      pending += decoder.decode(value, { stream: true });
    }
    const end = pending.indexOf("\n");
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    return line;
  }

  return {
    /**
     * Settles once the leftover process is running and has read its
     * environment.
     */
    async started(): Promise<void> {
      assertEquals(await readLine(), "ready");
    },

    /**
     * Has the leftover process write a file into the temporary directory its
     * environment names, and returns the path it wrote.
     */
    async writeIntoTemporaryDirectory(): Promise<string> {
      await writer.write(encoder.encode("\n"));
      const line = await readLine();
      const prefix = "wrote ";
      if (!line.startsWith(prefix)) {
        throw new Error(`The leftover process said ${JSON.stringify(line)}`);
      }
      return line.slice(prefix.length);
    },

    /**
     * Closes the cue, then reads standard output to its end, which the
     * leftover process reaches as it exits.
     */
    async close(): Promise<void> {
      await writer.close();
      let done = false;
      while (!done) ({ done } = await reader.read());
      reader.releaseLock();
    },
  };
}

Deno.test("dashboard test runner cleans up after a command that leaves a process running", async () => {
  const scratch = await Deno.makeTempDir({
    prefix: "commontools-dashboard-runner-test-",
  });
  const cacheDirectory = join(scratch, "cache");
  const temporaryDirectory = join(scratch, "temp");
  await Deno.mkdir(cacheDirectory);
  await Deno.mkdir(temporaryDirectory);
  let leftover: ReturnType<typeof openLeftoverProcess> | undefined;
  let written: string | undefined;
  let caches = 0;

  try {
    const code = await runDashboardTests({
      interrupts: [],
      makeTempDirectory: () => Promise.resolve(cacheDirectory),
      spawn: (args, env) => {
        if (!args.includes("test-browser")) {
          // A suite that runs no browser leaves a cache file behind, and
          // nothing else.
          const path = join(env.DASHBOARD_CACHE_DIR, `cache-${++caches}.json`);
          return {
            status: Deno.writeTextFile(path, "{}").then(() => ({ code: 0 })),
            kill: () => {},
          };
        }
        const child = new Deno.Command(Deno.execPath(), {
          args: ["eval", START_LEFTOVER_PROCESS, LEFTOVER_PROCESS],
          // The machine's own temporary directory sits underneath, and the
          // runner's environment goes on top of it, which is how `Deno.Command`
          // layers the two for the real commands.
          env: { TMPDIR: temporaryDirectory, ...env },
          stdin: "piped",
          stdout: "piped",
          stderr: "inherit",
        }).spawn();
        leftover = openLeftoverProcess(child);
        return child;
      },
      removeDirectory: async (directory) => {
        const leftoverProcess = leftover;
        if (!leftoverProcess) throw new Error("The browser command never ran");
        await leftoverProcess.started();
        // `Deno.remove(directory, { recursive: true })`, the removal the runner
        // performs, empties the directory and then removes it. Taking those two
        // steps apart here holds open the window between them that CI reaches
        // by chance, and gives the leftover process its turn inside it.
        for await (const entry of Deno.readDir(directory)) {
          await Deno.remove(join(directory, entry.name), { recursive: true });
        }
        written = await leftoverProcess.writeIntoTemporaryDirectory();
        await Deno.remove(directory);
      },
    });

    assertEquals(code, 0);
    assertEquals(dirname(written!), temporaryDirectory);
  } finally {
    await leftover?.close();
    await Deno.remove(scratch, { recursive: true });
  }
});
