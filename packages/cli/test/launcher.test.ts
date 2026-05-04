import { assertEquals, assertThrows } from "@std/assert";
import {
  buildCfLauncherCommand,
  defaultLabsRootFromModulePath,
  fileUrlToPath,
  formatCfLauncherUsage,
  parseCfLauncherArgs,
} from "../launcher.ts";

Deno.test("defaultLabsRootFromModulePath resolves from packages/cli", () => {
  assertEquals(
    defaultLabsRootFromModulePath("/workspace/labs/packages/cli/launcher.ts"),
    "/workspace/labs",
  );
});

Deno.test("defaultLabsRootFromModulePath preserves UNC roots", () => {
  assertEquals(
    defaultLabsRootFromModulePath(
      "//server/share/labs/packages/cli/launcher.ts",
    ),
    "//server/share/labs",
  );
});

Deno.test("fileUrlToPath converts drive and UNC file URLs", () => {
  assertEquals(
    fileUrlToPath("file:///C:/workspace/labs/packages/cli/launcher.ts"),
    "C:/workspace/labs/packages/cli/launcher.ts",
  );
  assertEquals(
    fileUrlToPath("file://server/share/labs/packages/cli/launcher.ts"),
    "//server/share/labs/packages/cli/launcher.ts",
  );
});

Deno.test("parseCfLauncherArgs defaults to the launcher labs checkout", () => {
  const parsed = parseCfLauncherArgs({
    argv: ["--", "--help"],
    cwd: "/workspace/labs",
    initCwd: "/workspace/pattern-factory",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/labs/packages/cli/launcher.ts",
  });

  assertEquals(parsed, {
    denoPath: "/usr/local/bin/deno",
    labsRoot: "/workspace/labs",
    configPath: "/workspace/labs/deno.json",
    cliEntrypoint: "/workspace/labs/packages/cli/mod.ts",
    cwd: "/workspace/pattern-factory",
    cfArgs: ["--help"],
  });
});

Deno.test("parseCfLauncherArgs supports explicit consumer config", () => {
  const parsed = parseCfLauncherArgs({
    argv: [
      "--labs-root",
      "vendor/labs",
      "--config",
      "deno.json",
      "--cwd",
      ".",
      "--",
      "piece",
      "apply",
      "--config",
      "piece-config.json",
    ],
    cwd: "/workspace/loom",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/loom/vendor/labs/packages/cli/launcher.ts",
  });

  assertEquals(parsed, {
    denoPath: "/usr/local/bin/deno",
    labsRoot: "/workspace/loom/vendor/labs",
    configPath: "/workspace/loom/deno.json",
    cliEntrypoint: "/workspace/loom/vendor/labs/packages/cli/mod.ts",
    cwd: "/workspace/loom",
    cfArgs: ["piece", "apply", "--config", "piece-config.json"],
  });
});

Deno.test("parseCfLauncherArgs forwards cf args after separator", () => {
  const parsed = parseCfLauncherArgs({
    argv: [
      "--labs-root",
      "../..",
      "--config",
      "../../deno.json",
      "--cli-entrypoint",
      "./mod.ts",
      "--",
      "--config",
      "piece-config.json",
    ],
    cwd: "/workspace/labs/packages/cli",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/labs/packages/cli/launcher.ts",
  });

  assertEquals("help" in parsed, false);
  if ("help" in parsed) {
    throw new Error("unexpected help result");
  }
  assertEquals(parsed.configPath, "/workspace/labs/deno.json");
  assertEquals(parsed.cfArgs, ["--config", "piece-config.json"]);
});

Deno.test("parseCfLauncherArgs treats the first non-launcher arg as cf args", () => {
  const parsed = parseCfLauncherArgs({
    argv: ["check", "pattern.tsx", "--no-run"],
    cwd: "/workspace/labs",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/labs/packages/cli/launcher.ts",
  });

  assertEquals("help" in parsed, false);
  if ("help" in parsed) {
    throw new Error("unexpected help result");
  }
  assertEquals(parsed.cfArgs, ["check", "pattern.tsx", "--no-run"]);
});

Deno.test("parseCfLauncherArgs reports launcher help for launcher-specific flag", () => {
  assertEquals(
    parseCfLauncherArgs({
      argv: ["--launcher-help"],
      cwd: "/workspace/labs",
      denoPath: "/usr/local/bin/deno",
      modulePath: "/workspace/labs/packages/cli/launcher.ts",
    }),
    { help: true },
  );
  assertEquals(formatCfLauncherUsage().includes("--labs-root"), true);
});

Deno.test("parseCfLauncherArgs passes cf help through to the child CLI", () => {
  const parsed = parseCfLauncherArgs({
    argv: ["--help"],
    cwd: "/workspace/labs",
    denoPath: "/usr/local/bin/deno",
    modulePath: "/workspace/labs/packages/cli/launcher.ts",
  });

  assertEquals("help" in parsed, false);
  if ("help" in parsed) {
    throw new Error("unexpected launcher help result");
  }
  assertEquals(parsed.cfArgs, ["--help"]);
});

Deno.test("parseCfLauncherArgs rejects missing option values", () => {
  assertThrows(
    () =>
      parseCfLauncherArgs({
        argv: ["--config"],
        cwd: "/workspace/labs",
        denoPath: "/usr/local/bin/deno",
        modulePath: "/workspace/labs/packages/cli/launcher.ts",
      }),
    Error,
    "--config requires a value",
  );
});

Deno.test("buildCfLauncherCommand builds the child deno invocation", () => {
  assertEquals(
    buildCfLauncherCommand({
      denoPath: "/usr/local/bin/deno",
      labsRoot: "/workspace/labs",
      configPath: "/workspace/labs/deno.json",
      cliEntrypoint: "/workspace/labs/packages/cli/mod.ts",
      cwd: "/workspace/pattern-factory",
      cfArgs: ["check", "pattern.tsx", "--no-run"],
    }),
    {
      command: "/usr/local/bin/deno",
      args: [
        "run",
        "--config",
        "/workspace/labs/deno.json",
        "--allow-net",
        "--allow-ffi",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "/workspace/labs/packages/cli/mod.ts",
        "check",
        "pattern.tsx",
        "--no-run",
      ],
      cwd: "/workspace/pattern-factory",
      env: {
        CF_CLI_NAME: "cf",
      },
    },
  );
});
