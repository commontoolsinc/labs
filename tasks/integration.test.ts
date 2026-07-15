import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  buildFilteredTestArgs,
  createMemoryWireAccountingToken,
  describeMemoryWireAccountingEnv,
  findIntegrationTestFiles,
  integrationTestDir,
  MEMORY_WIRE_ACCOUNTING_REQUIRED_ENV,
  MEMORY_WIRE_ACCOUNTING_TOKEN_ENV,
  memoryWireAccountingEnvForServerRun,
  runFilteredIntegration,
  runPackageIntegration,
  selectIntegrationTestFiles,
} from "./integration.ts";

Deno.test("selectIntegrationTestFiles keeps .test.ts files matching the filter", () => {
  const files = [
    "home-profile.test.ts",
    "counter.test.ts",
    "home-dashboard.test.ts",
    "README.md",
  ];
  assertEquals(selectIntegrationTestFiles(files, "home"), [
    "home-dashboard.test.ts",
    "home-profile.test.ts",
  ]);
});

Deno.test("selectIntegrationTestFiles matches a single file by name", () => {
  const files = ["home-profile.test.ts", "counter.test.ts"];
  assertEquals(selectIntegrationTestFiles(files, "home-profile"), [
    "home-profile.test.ts",
  ]);
});

Deno.test("selectIntegrationTestFiles prefers an exact filename match", () => {
  const files = ["counter.test.ts", "nested-counter.test.ts"];
  assertEquals(selectIntegrationTestFiles(files, "counter"), [
    "counter.test.ts",
  ]);
  assertEquals(selectIntegrationTestFiles(files, "counter.test.ts"), [
    "counter.test.ts",
  ]);
});

Deno.test("selectIntegrationTestFiles returns empty when nothing matches", () => {
  assertEquals(
    selectIntegrationTestFiles(["counter.test.ts"], "nonexistent"),
    [],
  );
});

Deno.test("selectIntegrationTestFiles ignores non-test files containing the filter", () => {
  assertEquals(
    selectIntegrationTestFiles(
      ["home.ts", "home.test.ts", "home.test.tsx", "home.txt"],
      "home",
    ),
    ["home.test.ts"],
  );
});

Deno.test("selectIntegrationTestFiles sorts the results", () => {
  assertEquals(
    selectIntegrationTestFiles(["b.test.ts", "a.test.ts"], ".test.ts"),
    ["a.test.ts", "b.test.ts"],
  );
});

Deno.test("integrationTestDir points generated-patterns at its patterns subdir", () => {
  assertEquals(
    integrationTestDir("generated-patterns"),
    "integration/patterns",
  );
});

Deno.test("integrationTestDir defaults to the integration directory", () => {
  assertEquals(integrationTestDir("patterns"), "integration");
  assertEquals(integrationTestDir("runner"), "integration");
  assertEquals(integrationTestDir("shell"), "integration");
});

Deno.test("findIntegrationTestFiles reads one level deep and filters by name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/home-profile.test.ts`, "");
    await Deno.writeTextFile(`${dir}/counter.test.ts`, "");
    await Deno.writeTextFile(`${dir}/notes.txt`, "");
    // A nested directory and the test file inside it are not descended into.
    await Deno.mkdir(`${dir}/reload`);
    await Deno.writeTextFile(`${dir}/reload/home-reload.test.ts`, "");

    assertEquals(await findIntegrationTestFiles(dir, "home"), [
      "home-profile.test.ts",
    ]);
    assertEquals(await findIntegrationTestFiles(dir, ""), [
      "counter.test.ts",
      "home-profile.test.ts",
    ]);
    assertEquals(await findIntegrationTestFiles(dir, "nope"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findIntegrationTestFiles returns empty for a missing directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await findIntegrationTestFiles(`${dir}/missing`, "home"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findIntegrationTestFiles rethrows errors other than a missing directory", async () => {
  const file = await Deno.makeTempFile();
  try {
    // Reading a file as a directory raises NotADirectory, not NotFound.
    await assertRejects(() => findIntegrationTestFiles(file, "home"));
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("buildFilteredTestArgs passes files as explicit paths under relDir", () => {
  assertEquals(
    buildFilteredTestArgs("runner", "integration", ["a.test.ts", "b.test.ts"]),
    ["test", "-A", "./integration/a.test.ts", "./integration/b.test.ts"],
  );
});

Deno.test("buildFilteredTestArgs adds patterns memory and leak flags", () => {
  assertEquals(
    buildFilteredTestArgs("patterns", "integration", ["home-profile.test.ts"]),
    [
      "test",
      "-A",
      "--v8-flags=--max-old-space-size=4096",
      "--trace-leaks",
      "./integration/home-profile.test.ts",
    ],
  );
});

Deno.test("buildFilteredTestArgs uses the generated-patterns subdir and flags", () => {
  assertEquals(
    buildFilteredTestArgs(
      "generated-patterns",
      "integration/patterns",
      ["simple-counter.test.ts"],
    ),
    [
      "test",
      "-A",
      "--trace-leaks",
      "--parallel",
      "./integration/patterns/simple-counter.test.ts",
    ],
  );
});

Deno.test("buildFilteredTestArgs adds a junit path when a junit dir is given", () => {
  assertEquals(
    buildFilteredTestArgs("shell", "integration", ["a.test.ts"], "out/junit"),
    [
      "test",
      "-A",
      "--junit-path=out/junit/shell.xml",
      "./integration/a.test.ts",
    ],
  );
});

Deno.test("createMemoryWireAccountingToken encodes high-entropy bytes without padding", () => {
  const token = createMemoryWireAccountingToken(new Uint8Array(32).fill(255));
  assertEquals(token.length, 43);
  assertEquals(token.includes("="), false);
  assertEquals(token.includes("+"), false);
  assertEquals(token.includes("/"), false);
});

Deno.test("memoryWireAccountingEnvForServerRun propagates token and defaults unset ENV to development", () => {
  const token = "secret-token-for-test";
  const env = memoryWireAccountingEnvForServerRun(token, undefined);

  assertEquals(env.serverEnv[MEMORY_WIRE_ACCOUNTING_TOKEN_ENV], token);
  assertEquals(env.serverEnv.ENV, "development");
  assertEquals(env.testEnv[MEMORY_WIRE_ACCOUNTING_TOKEN_ENV], token);
  assertEquals(env.testEnv[MEMORY_WIRE_ACCOUNTING_REQUIRED_ENV], "1");
  assertEquals(env.testEnv.ENV, undefined);
});

Deno.test("memoryWireAccountingEnvForServerRun defaults blank ENV to development", () => {
  const env = memoryWireAccountingEnvForServerRun("secret-token", "  ");

  assertEquals(env.serverEnv.ENV, "development");
});

Deno.test("memoryWireAccountingEnvForServerRun preserves allowed development ENV", () => {
  const token = "secret-token-for-test";
  const env = memoryWireAccountingEnvForServerRun(token, "development");

  assertEquals(env.serverEnv[MEMORY_WIRE_ACCOUNTING_TOKEN_ENV], token);
  assertEquals(env.serverEnv.ENV, "development");
  assertEquals(env.testEnv[MEMORY_WIRE_ACCOUNTING_TOKEN_ENV], token);
  assertEquals(env.testEnv[MEMORY_WIRE_ACCOUNTING_REQUIRED_ENV], "1");
  assertEquals(env.testEnv.ENV, undefined);
});

Deno.test("memoryWireAccountingEnvForServerRun preserves allowed test ENV", () => {
  const env = memoryWireAccountingEnvForServerRun("secret-token", "TEST");

  assertEquals(env.serverEnv.ENV, "test");
});

Deno.test("memoryWireAccountingEnvForServerRun rejects explicit production ENV without exposing token", () => {
  const token = "do-not-leak-this-token";
  const error = assertThrows(
    () => memoryWireAccountingEnvForServerRun(token, "production"),
    Error,
    'ENV="production"',
  );

  assert(!error.message.includes(token));
});

Deno.test("memoryWireAccountingEnvForServerRun rejects explicit staging ENV without exposing token", () => {
  const token = "do-not-leak-this-token";
  const error = assertThrows(
    () => memoryWireAccountingEnvForServerRun(token, "staging"),
    Error,
    'ENV="staging"',
  );

  assert(!error.message.includes(token));
});

Deno.test("memoryWireAccountingEnvForServerRun rejects unknown explicit ENV without exposing token", () => {
  const token = "do-not-leak-this-token";
  const error = assertThrows(
    () => memoryWireAccountingEnvForServerRun(token, "preview"),
    Error,
    'ENV="preview"',
  );

  assert(!error.message.includes(token));
});

Deno.test("describeMemoryWireAccountingEnv never exposes the bearer token", () => {
  const token = "do-not-print-this-token";
  const description = describeMemoryWireAccountingEnv({
    [MEMORY_WIRE_ACCOUNTING_TOKEN_ENV]: token,
  });

  assertEquals(description.includes(token), false);
  assertEquals(
    description,
    "Memory wire accounting token: configured (23 chars)",
  );
});

Deno.test("runFilteredIntegration fails without running when no file matches", async () => {
  const pkgDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${pkgDir}/integration`);
    await Deno.writeTextFile(`${pkgDir}/integration/counter.test.ts`, "");
    let ran = false;
    const result = await runFilteredIntegration(
      "runner",
      pkgDir,
      {},
      "no-such-test",
      undefined,
      () => {
        ran = true;
        return Promise.resolve({ success: true, code: 0 });
      },
    );
    assertEquals(result, { success: false, code: 1 });
    assertEquals(ran, false);
  } finally {
    await Deno.remove(pkgDir, { recursive: true });
  }
});

Deno.test("runFilteredIntegration runs deno test with the matching explicit paths", async () => {
  const pkgDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${pkgDir}/integration`);
    await Deno.writeTextFile(`${pkgDir}/integration/home-profile.test.ts`, "");
    await Deno.writeTextFile(`${pkgDir}/integration/counter.test.ts`, "");
    let captured: { cmd: string[]; cwd?: string } | undefined;
    const result = await runFilteredIntegration(
      "patterns",
      pkgDir,
      { LOG_LEVEL: "warn" },
      "home-profile",
      undefined,
      (cmd, options) => {
        captured = { cmd, cwd: options?.cwd };
        return Promise.resolve({ success: true, code: 0 });
      },
    );
    assertEquals(result, { success: true, code: 0 });
    assertEquals(captured?.cwd, pkgDir);
    assertEquals(captured?.cmd, [
      "deno",
      "test",
      "-A",
      "--v8-flags=--max-old-space-size=4096",
      "--trace-leaks",
      "./integration/home-profile.test.ts",
    ]);
  } finally {
    await Deno.remove(pkgDir, { recursive: true });
  }
});

Deno.test("runFilteredIntegration uses the generated-patterns subdir", async () => {
  const pkgDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${pkgDir}/integration/patterns`, { recursive: true });
    await Deno.writeTextFile(
      `${pkgDir}/integration/patterns/simple-counter.test.ts`,
      "",
    );
    let captured: string[] | undefined;
    await runFilteredIntegration(
      "generated-patterns",
      pkgDir,
      {},
      "simple-counter",
      undefined,
      (cmd) => {
        captured = cmd;
        return Promise.resolve({ success: true, code: 0 });
      },
    );
    assertEquals(captured, [
      "deno",
      "test",
      "-A",
      "--trace-leaks",
      "--parallel",
      "./integration/patterns/simple-counter.test.ts",
    ]);
  } finally {
    await Deno.remove(pkgDir, { recursive: true });
  }
});

Deno.test("runPackageIntegration returns false when a filtered run matches nothing", async () => {
  const rootDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${rootDir}/packages/runner/integration`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${rootDir}/packages/runner/integration/counter.test.ts`,
      "",
    );
    const ok = await runPackageIntegration(
      "runner",
      "",
      rootDir,
      "no-such-test",
    );
    assertEquals(ok, false);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});
