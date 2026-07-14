import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  defaultDependencies,
  type DemoDependencies,
  main,
  parseDemoArgs,
  resolveDemoTest,
  runDemo,
} from "./demo.ts";

Deno.test("parseDemoArgs accepts deterministic demo options", () => {
  assertEquals(
    parseDemoArgs([
      "patterns",
      "lunch-poll-vote",
      "--keep-frames",
      "--output=tmp/lunch.mp4",
      "--viewport=960x720",
      "--port-offset=500",
    ]),
    {
      packageName: "patterns",
      filter: "lunch-poll-vote",
      keepFrames: true,
      outputPath: "tmp/lunch.mp4",
      viewport: "960x720",
      portOffset: 500,
    },
  );
});

Deno.test("parseDemoArgs rejects non-browser packages", () => {
  assertThrows(
    () => parseDemoArgs(["runner", "counter"]),
    Error,
    "unsupported browser-test package",
  );
});

Deno.test("parseDemoArgs rejects invalid and incomplete options", () => {
  assertThrows(
    () => parseDemoArgs(["patterns", "demo", "--port-offset=-1"]),
    Error,
    "invalid --port-offset",
  );
  assertThrows(
    () => parseDemoArgs(["patterns", "demo", "--unknown"]),
    Error,
    "unknown option",
  );
  assertThrows(
    () => parseDemoArgs(["patterns"]),
    Error,
    "usage:",
  );
});

Deno.test("default demo dependencies provide time, preflight, and subprocess", async () => {
  assertEquals(defaultDependencies.now() instanceof Date, true);
  const previousFfmpeg = Deno.env.get("FFMPEG");
  Deno.env.set("FFMPEG", Deno.execPath());
  const root = await Deno.makeTempDir();
  try {
    await defaultDependencies.preflight();
    const status = await defaultDependencies.runIntegration(
      ["eval", "Deno.exit(0)"],
      root,
      {},
    );
    assertEquals(status.success, true);
  } finally {
    if (previousFfmpeg === undefined) Deno.env.delete("FFMPEG");
    else Deno.env.set("FFMPEG", previousFfmpeg);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("demo main handles help, errors, and an injected successful run", async () => {
  assertEquals(await main(["--help"]), 0);
  assertEquals(await main(["--unknown"]), 1);
  assertEquals(
    await main(["shell", "worker-runtime"], (options) => {
      assertEquals(options.packageName, "shell");
      return Promise.resolve(0);
    }),
    0,
  );
  assertEquals(
    await main(["shell", "worker-runtime"], () => Promise.reject("failed")),
    1,
  );
});

Deno.test("demo CLI help exits successfully", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "demo.ts", "--help"],
    cwd: import.meta.dirname,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  assertEquals(output.success, true);
  assertEquals(
    new TextDecoder().decode(output.stdout).includes("Usage:"),
    true,
  );
});

Deno.test("resolveDemoTest requires exactly one file", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/packages/patterns/integration`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/one-demo.test.ts`, "");
    await Deno.writeTextFile(`${dir}/two-demo.test.ts`, "");
    const base = parseDemoArgs(["patterns", "one-demo"]);
    assertEquals(await resolveDemoTest(root, base), "one-demo.test.ts");
    await assertRejects(
      () => resolveDemoTest(root, { ...base, filter: "demo" }),
      Error,
      "ambiguous",
    );
    await assertRejects(
      () => resolveDemoTest(root, { ...base, filter: "missing" }),
      Error,
      "no patterns integration test",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runDemo names and copies a successful video", async () => {
  await withDemoFixture(async (root) => {
    let preflighted = false;
    const dependencies = demoDependencies({
      preflight: () => {
        preflighted = true;
        return Promise.resolve();
      },
      runIntegration: async (args, cwd, env) => {
        assertEquals(args, [
          "task",
          "integration",
          "--port-offset=500",
          "patterns",
          "one-demo",
        ]);
        assertEquals(cwd, root);
        assertEquals(env.CF_DEMO_NAME, "one-demo");
        assertEquals(env.CF_DEMO_KEEP_FRAMES, "1");
        assertEquals(env.CF_DEMO_VIEWPORT, "960x720");
        await Deno.writeTextFile(
          `${env.CF_DEMO_OUTPUT_DIR}/one-demo.mp4`,
          "video bytes",
        );
        return { success: true, code: 0 };
      },
    });
    const result = await runDemo(
      {
        packageName: "patterns",
        filter: "one-demo",
        keepFrames: true,
        outputPath: "copied/one-demo.mp4",
        viewport: "960x720",
        portOffset: 500,
      },
      root,
      dependencies,
    );

    assertEquals(result, 0);
    assertEquals(preflighted, true);
    assertEquals(
      await Deno.readTextFile(`${root}/copied/one-demo.mp4`),
      "video bytes",
    );
  });
});

Deno.test("runDemo preserves a failing integration status and manifest", async () => {
  await withDemoFixture(async (root) => {
    const result = await runDemo(
      {
        packageName: "patterns",
        filter: "one-demo",
        keepFrames: false,
      },
      root,
      demoDependencies({
        runIntegration: async (_args, _cwd, env) => {
          await Deno.writeTextFile(
            `${env.CF_DEMO_OUTPUT_DIR}/manifest.json`,
            JSON.stringify({ status: "passed" }),
          );
          return { success: false, code: 7 };
        },
      }),
    );

    assertEquals(result, 7);
    const manifest = JSON.parse(
      await Deno.readTextFile(
        `${demoRunDir(root)}/manifest.json`,
      ),
    );
    assertEquals(manifest.status, "test-failed");
    assertEquals(manifest.error, "integration test exited with code 7");
  });
});

Deno.test("runDemo rejects a successful test without a video", async () => {
  await withDemoFixture(async (root) => {
    await assertRejects(
      () =>
        runDemo(
          {
            packageName: "patterns",
            filter: "one-demo",
            keepFrames: false,
          },
          root,
          demoDependencies(),
        ),
      Error,
      "did not produce one-demo.mp4",
    );
  });
});

Deno.test("runDemo retains a named video in its artifact directory", async () => {
  await withDemoFixture(async (root) => {
    const result = await runDemo(
      {
        packageName: "patterns",
        filter: "one-demo",
        keepFrames: false,
      },
      root,
      demoDependencies({
        runIntegration: async (_args, _cwd, env) => {
          await Deno.writeTextFile(
            `${env.CF_DEMO_OUTPUT_DIR}/one-demo.mp4`,
            "video bytes",
          );
          return { success: true, code: 0 };
        },
      }),
    );
    assertEquals(result, 0);
    assertEquals(
      await Deno.readTextFile(`${demoRunDir(root)}/one-demo.mp4`),
      "video bytes",
    );
  });
});

Deno.test("runDemo preserves a setup failure without a manifest", async () => {
  await withDemoFixture(async (root) => {
    assertEquals(
      await runDemo(
        {
          packageName: "patterns",
          filter: "one-demo",
          keepFrames: false,
        },
        root,
        demoDependencies({
          runIntegration: () => Promise.resolve({ success: false, code: 4 }),
        }),
      ),
      4,
    );
  });
});

const FIXED_NOW = new Date("2026-07-14T00:00:00.000Z");

function demoDependencies(
  overrides: Partial<DemoDependencies> = {},
): DemoDependencies {
  return {
    now: () => FIXED_NOW,
    preflight: () => Promise.resolve(),
    runIntegration: () => Promise.resolve({ success: true, code: 0 }),
    ...overrides,
  };
}

function demoRunDir(root: string): string {
  return `${root}/tmp/demos/patterns-one-demo-2026-07-14T00-00-00-000Z`;
}

async function withDemoFixture(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/packages/patterns/integration`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/one-demo.test.ts`, "");
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
