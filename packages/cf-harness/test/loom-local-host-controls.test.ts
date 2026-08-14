import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { InMemoryHarnessCredentialStore } from "../src/auth/credential-store.ts";
import type { CfHarnessCliIO } from "../src/cli.ts";
import {
  createCfHarnessCliCapabilities,
  formatCfHarnessCliUsage,
} from "../src/cli.ts";
import { createLoomLocalCfHarnessHost } from "../src/loom-local-host.ts";
import { runLoomLocalCfHarnessHostMain } from "../src/loom-local-host-main.ts";

const ioBuffers = (): {
  io: CfHarnessCliIO;
  stdout: string[];
  stderr: string[];
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
};

Deno.test("local Loom batch informational controls bypass provider and auth state", async () => {
  const controls: Array<{
    args: readonly string[];
    expected: "help" | "capabilities";
  }> = [
    { args: ["--help"], expected: "help" },
    { args: ["-h"], expected: "help" },
    { args: ["--describe-capabilities"], expected: "capabilities" },
    { args: ["--", "--help"], expected: "help" },
  ];

  for (const testCase of controls) {
    const home = await Deno.makeTempDir();
    let providerReads = 0;
    let credentialReads = 0;
    let providerRequests = 0;
    const credentials = new InMemoryHarnessCredentialStore();
    const originalGetRecord = credentials.getRecord.bind(credentials);
    credentials.getRecord = (...args) => {
      credentialReads += 1;
      return originalGetRecord(...args);
    };
    const io = ioBuffers();
    const host = await createLoomLocalCfHarnessHost({
      harnessHome: home,
      env: {},
      credentialStore: credentials,
      providerSettingsStore: {
        inspect: () => {
          providerReads += 1;
          return Promise.reject(new Error("provider state must not be read"));
        },
      },
      fetchFn: () => {
        providerRequests += 1;
        return Promise.reject(new Error("provider traffic must not occur"));
      },
      cliDependencies: { cwd: home, io: io.io },
    });

    assertEquals(await host.runBatch(testCase.args), 0);
    assertEquals(io.stderr, []);
    assertEquals(providerReads, 0);
    assertEquals(credentialReads, 0);
    assertEquals(providerRequests, 0);
    if (testCase.expected === "help") {
      assertEquals(io.stdout, [formatCfHarnessCliUsage()]);
    } else {
      assertEquals(
        JSON.parse(io.stdout.join("")),
        createCfHarnessCliCapabilities(),
      );
    }
  }
});

Deno.test("local Loom batch control-looking prompt text does not bypass binding", async () => {
  const home = await Deno.makeTempDir();
  const io = ioBuffers();
  const host = await createLoomLocalCfHarnessHost({
    harnessHome: home,
    env: {},
    providerSettingsStore: {
      inspect: () => Promise.resolve({ state: "missing" as const }),
    },
    cliDependencies: { cwd: home, io: io.io },
  });

  assertEquals(
    await host.runBatch(["--output-mode", "batch", "--", "--help"]),
    1,
  );
  assertEquals(io.stdout, []);
  assertEquals(
    JSON.parse(io.stderr.join("")).error.code,
    "provider-configuration-required",
  );
});

Deno.test("local Loom batch executable exposes help and capabilities before setup", async () => {
  const entrypoint = fromFileUrl(
    new URL("../src/loom-local-host-main.ts", import.meta.url),
  );
  for (const control of ["--help", "--describe-capabilities"] as const) {
    const home = await Deno.makeTempDir();
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--quiet",
        "--no-lock",
        "-A",
        entrypoint,
        "batch",
        "--",
        control,
      ],
      env: {
        CF_HARNESS_HOME: home,
        CF_HARNESS_MODEL_PROVIDER: "",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);

    assertEquals(result.code, 0, control);
    assertEquals(stderr, "", control);
    if (control === "--help") {
      assertStringIncludes(stdout, "Usage:");
      assertStringIncludes(stdout, "--describe-capabilities");
    } else {
      assertEquals(JSON.parse(stdout), createCfHarnessCliCapabilities());
    }
  }
});

Deno.test("local Loom interactive executable reports a missing dedicated home on its protocol", async () => {
  const entrypoint = fromFileUrl(
    new URL("../src/loom-local-host-main.ts", import.meta.url),
  );
  const coverageDir = Deno.env.get("DENO_COVERAGE_DIR");
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--no-lock",
      "-A",
      entrypoint,
      "interactive",
    ],
    clearEnv: true,
    env: coverageDir === undefined ? {} : { DENO_COVERAGE_DIR: coverageDir },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 1);
  assertEquals(new TextDecoder().decode(result.stdout), "");
  assertEquals(new TextDecoder().decode(result.stderr), "");
});

Deno.test("local Loom host main classifies startup and batch routing failures in process", async () => {
  const home = await Deno.makeTempDir();

  assertEquals(await runLoomLocalCfHarnessHostMain(["unknown"], {}), 1);
  assertEquals(await runLoomLocalCfHarnessHostMain(["batch"], {}), 1);
  assertEquals(
    await runLoomLocalCfHarnessHostMain(
      ["batch", "--", "--help"],
      { CF_HARNESS_HOME: home, CF_HARNESS_MODEL_PROVIDER: "" },
    ),
    0,
  );
  assertEquals(
    await runLoomLocalCfHarnessHostMain(
      ["interactive", "--", "--help"],
      { CF_HARNESS_HOME: home, CF_HARNESS_MODEL_PROVIDER: "" },
    ),
    0,
  );
  assertEquals(
    await runLoomLocalCfHarnessHostMain(
      ["batch", "--", "--prompt", "hello"],
      { CF_HARNESS_HOME: "relative/home" },
    ),
    1,
  );
});
