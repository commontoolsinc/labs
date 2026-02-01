/**
 * Comprehensive tests for Sandboxed Real Execution
 *
 * Tests cover:
 * - SandboxedExecConfig merging
 * - Profile lookup and merging
 * - Executor in stub mode (returns appropriate message and labels)
 * - Output label is conservative join of inputs + SandboxedExec integrity
 * - VFS bridge export creates correct directory structure
 * - VFS bridge import reads files with correct labels
 * - !real command parses flags correctly
 * - !real command requires intent
 * - !real --net adds network taint to output label
 * - Timeout configuration propagates
 */

import { assertEquals, assert, assertRejects } from "jsr:@std/assert";
import {
  SandboxedExecConfig,
  defaultConfig,
  mergeConfig,
  getProfile,
  profiles,
} from "../src/sandbox/config.ts";
import { SandboxedExecutor } from "../src/sandbox/executor.ts";
import { exportToReal, importFromReal } from "../src/sandbox/vfs-bridge.ts";
import { realCommand } from "../src/commands/real.ts";
import { labels, Label } from "../src/labels.ts";
import { VFS } from "../src/vfs.ts";
import { LabeledStream } from "../src/labeled-stream.ts";
import { createEnvironment, CommandContext } from "../src/commands/context.ts";

// ============================================================================
// Helper Functions
// ============================================================================

function labelEqual(a: Label, b: Label): boolean {
  // Check confidentiality clauses (order doesn't matter)
  if (a.confidentiality.length !== b.confidentiality.length) return false;
  for (const clauseA of a.confidentiality) {
    const found = b.confidentiality.some(clauseB =>
      clauseA.length === clauseB.length &&
      clauseA.every(atomA => clauseB.some(atomB => atomEqual(atomA, atomB)))
    );
    if (!found) return false;
  }

  // Check integrity atoms (order doesn't matter)
  if (a.integrity.length !== b.integrity.length) return false;
  for (const atomA of a.integrity) {
    if (!b.integrity.some(atomB => atomEqual(atomA, atomB))) return false;
  }

  return true;
}

function atomEqual(a: any, b: any): boolean {
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case "Origin":
      return a.url === b.url;
    case "CodeHash":
      return a.hash === b.hash;
    case "EndorsedBy":
      return a.principal === b.principal;
    case "AuthoredBy":
      return a.principal === b.principal;
    case "LLMGenerated":
      return a.model === b.model;
    case "UserInput":
      return true;
    case "NetworkProvenance":
      return a.tls === b.tls && a.host === b.host;
    case "TransformedBy":
      return a.command === b.command;
    case "Space":
      return a.id === b.id;
    case "PersonalSpace":
      return a.did === b.did;
    case "SandboxedExec":
      return true;
    case "Custom":
      return a.tag === b.tag && a.value === b.value;
    default:
      return false;
  }
}

function createMockContext(vfs?: VFS): CommandContext {
  return {
    vfs: vfs || new VFS(),
    env: createEnvironment(),
    stdin: new LabeledStream(),
    stdout: new LabeledStream(),
    stderr: new LabeledStream(),
    pcLabel: labels.bottom(),
    requestIntent: async () => true,
  };
}

// ============================================================================
// Config Tests
// ============================================================================

Deno.test("defaultConfig has sensible defaults", () => {
  assertEquals(defaultConfig.allowNetwork, false);
  assertEquals(defaultConfig.allowedReadPaths.length, 0);
  assertEquals(defaultConfig.allowedWritePaths.length, 0);
  assertEquals(defaultConfig.timeout, 30000);
  assertEquals(defaultConfig.memoryLimit, 256 * 1024 * 1024);
});

Deno.test("mergeConfig merges correctly", () => {
  const base: SandboxedExecConfig = {
    ...defaultConfig,
    timeout: 10000,
    env: { BASE_VAR: "base" },
  };

  const overrides: Partial<SandboxedExecConfig> = {
    allowNetwork: true,
    timeout: 20000,
    env: { OVERRIDE_VAR: "override" },
  };

  const merged = mergeConfig(base, overrides);

  assertEquals(merged.allowNetwork, true);
  assertEquals(merged.timeout, 20000);
  assertEquals(merged.env.BASE_VAR, "base");
  assertEquals(merged.env.OVERRIDE_VAR, "override");
});

Deno.test("mergeConfig preserves unspecified values", () => {
  const base: SandboxedExecConfig = {
    ...defaultConfig,
    allowNetwork: true,
    allowedReadPaths: ["/data"],
  };

  const merged = mergeConfig(base, {});

  assertEquals(merged.allowNetwork, true);
  assertEquals(merged.allowedReadPaths, ["/data"]);
});

Deno.test("profiles are defined", () => {
  assert(profiles["python-data"] !== undefined);
  assert(profiles["npm-install"] !== undefined);
  assert(profiles["build"] !== undefined);
});

Deno.test("getProfile returns profile by name", () => {
  const profile = getProfile("python-data");
  assert(profile !== null);
  assertEquals(profile!.name, "python-data");
  assertEquals(profile!.config.allowNetwork, false);
});

Deno.test("getProfile returns null for unknown profile", () => {
  const profile = getProfile("nonexistent");
  assertEquals(profile, null);
});

Deno.test("profile merging works", () => {
  const profile = getProfile("npm-install")!;
  const merged = mergeConfig(defaultConfig, profile.config);

  assertEquals(merged.allowNetwork, true);
  assertEquals(merged.timeout, 120000);
});

// ============================================================================
// Executor Tests (Stub Mode)
// ============================================================================

Deno.test("SandboxedExecutor in stub mode returns appropriate message", async () => {
  const executor = new SandboxedExecutor(defaultConfig);
  const vfs = new VFS();

  const result = await executor.execute(
    "python",
    ["script.py"],
    null,
    [],
    vfs,
    [],
  );

  assertEquals(result.exitCode, 1);
  assert(result.stderr.value.includes("Sandboxed execution not available"));
  assert(result.stderr.value.includes("python script.py"));
});

Deno.test("Executor stub mode applies correct labels with no inputs", async () => {
  const executor = new SandboxedExecutor(defaultConfig);
  const vfs = new VFS();

  const result = await executor.execute(
    "echo",
    ["hello"],
    null,
    [],
    vfs,
    [],
  );

  // Should have SandboxedExec integrity
  assert(
    labels.hasIntegrity(result.stdout.label, { kind: "SandboxedExec" }),
    "Should have SandboxedExec integrity",
  );
  assert(
    labels.hasIntegrity(result.stderr.label, { kind: "SandboxedExec" }),
    "Should have SandboxedExec integrity",
  );
});

Deno.test("Executor stub mode joins input labels conservatively", async () => {
  const executor = new SandboxedExecutor(defaultConfig);
  const vfs = new VFS();

  const input1 = labels.userInput();
  const input2 = labels.fromNetwork("https://example.com", true);

  const stdinLabel = labels.fromFile("/data.txt", "space1");

  const result = await executor.execute(
    "process",
    ["--input"],
    { value: "input data", label: stdinLabel },
    [input1, input2],
    vfs,
    [],
  );

  // Output should join all inputs
  const expectedLabel = labels.joinAll([input1, input2, stdinLabel]);

  // Should have SandboxedExec integrity
  assert(
    labels.hasIntegrity(result.stdout.label, { kind: "SandboxedExec" }),
    "Should have SandboxedExec integrity",
  );

  // Confidentiality should be join of all inputs
  // (in this case, space1 from stdin)
  assertEquals(
    result.stdout.label.confidentiality.length,
    expectedLabel.confidentiality.length,
  );
});

Deno.test("Executor with network adds network taint", async () => {
  const configWithNetwork = mergeConfig(defaultConfig, { allowNetwork: true });
  const executor = new SandboxedExecutor(configWithNetwork);
  const vfs = new VFS();

  const result = await executor.execute(
    "curl",
    ["https://example.com"],
    null,
    [],
    vfs,
    [],
  );

  // Should have NetworkProvenance integrity
  assert(
    labels.hasAnyIntegrity(result.stdout.label, [
      { kind: "NetworkProvenance", tls: false, host: "unknown" },
    ]),
    "Should have NetworkProvenance integrity when network is allowed",
  );
});

// ============================================================================
// VFS Bridge Tests
// ============================================================================

Deno.test("exportToReal handles non-existent paths gracefully", async () => {
  const vfs = new VFS();

  // Create a temp directory for testing
  const tempDir = await Deno.makeTempDir({ prefix: "cfc-test-" });

  try {
    const labelMap = await exportToReal(vfs, ["/nonexistent"], tempDir);

    // Should return empty map for non-existent paths
    assertEquals(labelMap.size, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("exportToReal exports file with correct label", async () => {
  const vfs = new VFS();
  const fileLabel = labels.fromFile("/test.txt", "test-space");

  // Write a file to VFS
  vfs.writeFile("/test.txt", "Hello, World!", fileLabel);

  const tempDir = await Deno.makeTempDir({ prefix: "cfc-test-" });

  try {
    const labelMap = await exportToReal(vfs, ["/test.txt"], tempDir);

    // Should have exported the file with its label
    assertEquals(labelMap.size, 1);
    assert(labelMap.has("/test.txt"));

    const exportedLabel = labelMap.get("/test.txt")!;
    assert(labelEqual(exportedLabel, fileLabel));

    // Verify file exists in real filesystem
    const content = await Deno.readTextFile(`${tempDir}/test.txt`);
    assertEquals(content, "Hello, World!");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("exportToReal exports directory recursively", async () => {
  const vfs = new VFS();

  // Create directory structure
  vfs.mkdir("/data", true);
  vfs.writeFile("/data/file1.txt", "File 1", labels.userInput());
  vfs.mkdir("/data/subdir", true);
  vfs.writeFile("/data/subdir/file2.txt", "File 2", labels.llmGenerated());

  const tempDir = await Deno.makeTempDir({ prefix: "cfc-test-" });

  try {
    const labelMap = await exportToReal(vfs, ["/data"], tempDir);

    // Should have exported all files
    assertEquals(labelMap.size, 2);
    assert(labelMap.has("/data/file1.txt"));
    assert(labelMap.has("/data/subdir/file2.txt"));

    // Verify files exist
    const content1 = await Deno.readTextFile(`${tempDir}/data/file1.txt`);
    assertEquals(content1, "File 1");

    const content2 = await Deno.readTextFile(`${tempDir}/data/subdir/file2.txt`);
    assertEquals(content2, "File 2");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("importFromReal imports files with correct label", async () => {
  const vfs = new VFS();
  const importLabel = labels.fromNetwork("https://example.com", true);

  const tempDir = await Deno.makeTempDir({ prefix: "cfc-test-" });

  try {
    // Create files in real filesystem
    await Deno.writeTextFile(`${tempDir}/imported.txt`, "Imported content");

    // Import to VFS
    const imported = await importFromReal(vfs, tempDir, "/imported", importLabel);

    // Should have imported one file
    assertEquals(imported.length, 1);
    assertEquals(imported[0], "/imported/imported.txt");

    // Verify file in VFS has correct content and label
    const { value, label } = vfs.readFileText("/imported/imported.txt");
    assertEquals(value, "Imported content");
    assert(labelEqual(label, importLabel));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("importFromReal imports nested directories", async () => {
  const vfs = new VFS();
  const importLabel = labels.bottom();

  const tempDir = await Deno.makeTempDir({ prefix: "cfc-test-" });

  try {
    // Create nested structure in real filesystem
    await Deno.mkdir(`${tempDir}/subdir`, { recursive: true });
    await Deno.writeTextFile(`${tempDir}/file1.txt`, "File 1");
    await Deno.writeTextFile(`${tempDir}/subdir/file2.txt`, "File 2");

    // Import to VFS
    const imported = await importFromReal(vfs, tempDir, "/", importLabel);

    // Should have imported both files
    assertEquals(imported.length, 2);
    assert(imported.includes("/file1.txt"));
    assert(imported.includes("/subdir/file2.txt"));

    // Verify contents
    const { value: v1 } = vfs.readFileText("/file1.txt");
    assertEquals(v1, "File 1");

    const { value: v2 } = vfs.readFileText("/subdir/file2.txt");
    assertEquals(v2, "File 2");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// !real Command Tests
// ============================================================================

Deno.test("!real parses basic command", async () => {
  const ctx = createMockContext();
  ctx.stdin.close();

  const result = await realCommand(["echo", "hello"], ctx);

  // In stub mode, should return exit code 1
  assertEquals(result.exitCode, 1);

  // Should have written to stderr
  const stderrOutput = await ctx.stderr.readAll();
  assert(stderrOutput.value.includes("Sandboxed execution not available"));
});

Deno.test("!real parses --net flag", async () => {
  const ctx = createMockContext();
  ctx.stdin.close();

  // The command will run in stub mode but we can verify it doesn't error on flags
  await realCommand(["--net", "--", "curl", "https://example.com"], ctx);

  // Should complete without throwing
  assert(true);
});

Deno.test("!real parses --read and --write flags", async () => {
  const vfs = new VFS();
  vfs.writeFile("/input.txt", "input data", labels.userInput());

  const ctx = createMockContext(vfs);
  ctx.stdin.close();

  await realCommand(
    ["--read", "/input.txt", "--write", "/output", "--", "process"],
    ctx,
  );

  // Should complete without throwing
  assert(true);
});

Deno.test("!real parses --timeout flag", async () => {
  const ctx = createMockContext();
  ctx.stdin.close();

  await realCommand(["--timeout", "5000", "--", "sleep", "1"], ctx);

  // Should complete without throwing
  assert(true);
});

Deno.test("!real parses --profile flag", async () => {
  const ctx = createMockContext();
  ctx.stdin.close();

  await realCommand(["--profile", "python-data", "--", "python", "script.py"], ctx);

  // Should complete without throwing
  assert(true);
});

Deno.test("!real errors on unknown profile", async () => {
  const ctx = createMockContext();
  ctx.stdin.close();

  const result = await realCommand(
    ["--profile", "nonexistent", "--", "command"],
    ctx,
  );

  assertEquals(result.exitCode, 1);

  const stderrOutput = await ctx.stderr.readAll();
  assert(stderrOutput.value.includes("Unknown profile"));
});

Deno.test("!real errors when no command provided", async () => {
  const ctx = createMockContext();
  ctx.stdin.close();

  const result = await realCommand([], ctx);

  assertEquals(result.exitCode, 1);

  const stderrOutput = await ctx.stderr.readAll();
  assert(stderrOutput.value.includes("requires a COMMAND"));
});

Deno.test("!real errors on --read without PATH", async () => {
  const ctx = createMockContext();
  ctx.stdin.close();

  const result = await realCommand(["--read"], ctx);

  assertEquals(result.exitCode, 1);

  const stderrOutput = await ctx.stderr.readAll();
  assert(stderrOutput.value.includes("requires a PATH"));
});

Deno.test("!real requires intent", async () => {
  const ctx = createMockContext();
  ctx.stdin.close();

  // Mock intent callback that denies
  ctx.requestIntent = async () => false;

  const result = await realCommand(["echo", "hello"], ctx);

  assertEquals(result.exitCode, 1);

  const stderrOutput = await ctx.stderr.readAll();
  assert(stderrOutput.value.includes("denied intent"));
});

Deno.test("!real propagates stdin label", async () => {
  const ctx = createMockContext();

  // Write labeled stdin
  const stdinLabel = labels.fromFile("/secret.txt", "secret-space");
  ctx.stdin.write("secret data", stdinLabel);
  ctx.stdin.close();

  await realCommand(["cat"], ctx);

  // Output should have stdin's confidentiality
  const stdoutOutput = await ctx.stdout.readAll();

  // The output label should preserve the confidentiality from stdin
  assertEquals(
    stdoutOutput.label.confidentiality.length,
    stdinLabel.confidentiality.length,
  );
});

Deno.test("!real adds SandboxedExec integrity to output", async () => {
  const ctx = createMockContext();
  ctx.stdin.close();

  await realCommand(["echo", "hello"], ctx);

  const stdoutOutput = await ctx.stdout.readAll();

  // Should have SandboxedExec integrity
  assert(
    labels.hasIntegrity(stdoutOutput.label, { kind: "SandboxedExec" }),
    "Output should have SandboxedExec integrity",
  );
});

Deno.test("!real with --net adds network taint", async () => {
  const ctx = createMockContext();
  ctx.stdin.close();

  await realCommand(["--net", "--", "curl", "https://example.com"], ctx);

  const stdoutOutput = await ctx.stdout.readAll();

  // Should have network-related integrity
  assert(
    labels.hasAnyIntegrity(stdoutOutput.label, [
      { kind: "NetworkProvenance", tls: false, host: "unknown" },
    ]),
    "Output should have network taint when --net is used",
  );
});

Deno.test("!real collects labels from read paths", async () => {
  const vfs = new VFS();
  const fileLabel = labels.fromFile("/data.txt", "data-space");
  vfs.writeFile("/data.txt", "data content", fileLabel);

  const ctx = createMockContext(vfs);
  ctx.stdin.close();

  await realCommand(["--read", "/data.txt", "--", "process"], ctx);

  const stdoutOutput = await ctx.stdout.readAll();

  // Output should have confidentiality from the read file
  assertEquals(
    stdoutOutput.label.confidentiality.length,
    fileLabel.confidentiality.length,
  );
});

// ============================================================================
// Integration Tests
// ============================================================================

Deno.test("Integration: conservative label propagation through sandbox", async () => {
  const vfs = new VFS();
  const executor = new SandboxedExecutor(defaultConfig);

  // Create inputs with different labels
  const userLabel = labels.userInput();
  const networkLabel = labels.fromNetwork("https://example.com", true);

  const result = await executor.execute(
    "process",
    ["--input"],
    { value: "user input", label: userLabel },
    [networkLabel],
    vfs,
    [],
  );

  // Output should:
  // 1. Have SandboxedExec integrity
  assert(
    labels.hasIntegrity(result.stdout.label, { kind: "SandboxedExec" }),
    "Should have SandboxedExec integrity",
  );

  // 2. Have no other integrity (intersection of UserInput and Origin is empty)
  // Plus SandboxedExec = 1 integrity atom
  const sandboxedExecCount = result.stdout.label.integrity.filter(
    a => a.kind === "SandboxedExec"
  ).length;
  assert(sandboxedExecCount >= 1, "Should have at least SandboxedExec integrity");
});

Deno.test("Integration: timeout configuration propagates", async () => {
  const shortTimeout = 100;
  const config = mergeConfig(defaultConfig, { timeout: shortTimeout });
  const executor = new SandboxedExecutor(config);

  assertEquals(executor.getConfig().timeout, shortTimeout);
});

Deno.test("Integration: config updates work", () => {
  const executor = new SandboxedExecutor(defaultConfig);

  const newConfig = mergeConfig(defaultConfig, {
    allowNetwork: true,
    timeout: 60000,
  });

  executor.setConfig(newConfig);

  const config = executor.getConfig();
  assertEquals(config.allowNetwork, true);
  assertEquals(config.timeout, 60000);
});

Deno.test("Integration: mergeConfig on executor works", () => {
  const executor = new SandboxedExecutor(defaultConfig);

  executor.mergeConfig({ allowNetwork: true });

  const config = executor.getConfig();
  assertEquals(config.allowNetwork, true);
  // Other values should remain at defaults
  assertEquals(config.timeout, defaultConfig.timeout);
});
