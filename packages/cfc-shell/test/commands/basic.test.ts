/**
 * Basic command tests
 */

import { assertEquals } from "jsr:@std/assert";
import { VFS } from "../../src/vfs.ts";
import { labels } from "../../src/labels.ts";
import { LabeledStream } from "../../src/labeled-stream.ts";
import { createEnvironment, type CommandContext } from "../../src/commands/context.ts";
import { createDefaultRegistry } from "../../src/commands/mod.ts";

/**
 * Helper to create a test context
 */
function createTestContext(): {
  vfs: VFS;
  ctx: CommandContext;
  stdout: LabeledStream;
  stderr: LabeledStream;
} {
  const vfs = new VFS();
  const env = createEnvironment({
    HOME: { value: "/home/user", label: labels.userInput() },
    PATH: { value: "/usr/bin", label: labels.userInput() },
  });

  const stdin = LabeledStream.empty();
  const stdout = new LabeledStream();
  const stderr = new LabeledStream();

  const ctx: CommandContext = {
    vfs,
    env,
    stdin,
    stdout,
    stderr,
    pcLabel: labels.userInput(),
    requestIntent: async () => false,
  };

  return { vfs, ctx, stdout, stderr };
}

Deno.test("echo writes to stdout with correct label", async () => {
  const registry = createDefaultRegistry();
  const { ctx, stdout } = createTestContext();

  const echo = registry.get("echo")!;
  const result = await echo(["hello", "world"], ctx);

  assertEquals(result.exitCode, 0);

  const output = await stdout.readAll();
  assertEquals(output.value, "hello world\n");
  assertEquals(output.label.integrity.length, 1);
  assertEquals(output.label.integrity[0].kind, "UserInput");
});

Deno.test("cat reads file with file's label", async () => {
  const registry = createDefaultRegistry();
  const { vfs, ctx, stdout } = createTestContext();

  // Create a file with specific label
  const fileLabel = labels.fromNetwork("https://example.com", true);
  vfs.writeFile("/test.txt", "secret data", fileLabel);

  const cat = registry.get("cat")!;
  const result = await cat(["/test.txt"], ctx);

  assertEquals(result.exitCode, 0);

  const output = await stdout.readAll();
  assertEquals(output.value, "secret data");

  // Should have Origin and NetworkProvenance in integrity
  const hasOrigin = output.label.integrity.some(a => a.kind === "Origin");
  const hasNetworkProv = output.label.integrity.some(a => a.kind === "NetworkProvenance");
  assertEquals(hasOrigin, true);
  assertEquals(hasNetworkProv, true);
});

Deno.test("grep filters and joins labels correctly", async () => {
  const registry = createDefaultRegistry();
  const { vfs, ctx, stdout } = createTestContext();

  // Create a file
  const fileLabel = labels.fromFile("/data.txt");
  vfs.writeFile("/data.txt", "line1\nline2 match\nline3\nline4 match", fileLabel);

  const grep = registry.get("grep")!;
  const result = await grep(["match", "/data.txt"], ctx);

  assertEquals(result.exitCode, 0);

  const output = await stdout.readAll();
  assertEquals(output.value, "line2 match\nline4 match\n");

  // Label should be joined with PC label
  assertEquals(output.label.integrity.length, 1);
  assertEquals(output.label.integrity[0].kind, "UserInput");
});

Deno.test("ls lists directory contents", async () => {
  const registry = createDefaultRegistry();
  const { vfs, ctx, stdout } = createTestContext();

  // Create some files
  vfs.mkdir("/test", false);
  vfs.writeFile("/test/file1.txt", "data1", labels.bottom());
  vfs.writeFile("/test/file2.txt", "data2", labels.bottom());

  const ls = registry.get("ls")!;
  const result = await ls(["/test"], ctx);

  assertEquals(result.exitCode, 0);

  const output = await stdout.readAll();
  const lines = output.value.trim().split("\n").sort();
  assertEquals(lines, ["file1.txt", "file2.txt"]);
});

Deno.test("cp preserves labels", async () => {
  const registry = createDefaultRegistry();
  const { vfs, ctx } = createTestContext();

  // Create a file with a specific label
  const srcLabel = labels.fromNetwork("https://secret.com", true);
  vfs.writeFile("/src.txt", "secret", srcLabel);

  const cp = registry.get("cp")!;
  const result = await cp(["/src.txt", "/dst.txt"], ctx);

  assertEquals(result.exitCode, 0);

  // Check destination has the same label
  const { label: dstLabel } = vfs.readFile("/dst.txt");

  const srcHasOrigin = srcLabel.integrity.some(a => a.kind === "Origin");
  const dstHasOrigin = dstLabel.integrity.some(a => a.kind === "Origin");
  assertEquals(srcHasOrigin, dstHasOrigin);
});

Deno.test("environment variables preserve labels", async () => {
  const { ctx } = createTestContext();

  const secretLabel = labels.fromFile("/etc/secret");
  ctx.env.set("SECRET", "my-secret", secretLabel);

  const retrieved = ctx.env.get("SECRET");
  assertEquals(retrieved?.value, "my-secret");
  assertEquals(retrieved?.label, secretLabel);
});

Deno.test("exec blocks low-integrity content", async () => {
  const registry = createDefaultRegistry();
  const { vfs, ctx, stderr } = createTestContext();

  // Create a script with LLM-generated content (low integrity)
  const scriptLabel = labels.llmGenerated("gpt-4");
  vfs.writeFile("/malicious.sh", "rm -rf /", scriptLabel);

  const bash = registry.get("bash")!;
  const result = await bash(["/malicious.sh"], ctx);

  // Should be blocked
  assertEquals(result.exitCode, 126);

  const errorOutput = await stderr.readAll();
  assertEquals(errorOutput.value.includes("Blocked"), true);
  assertEquals(errorOutput.value.includes("integrity"), true);
});

Deno.test("curl stub blocks with explanation", async () => {
  const registry = createDefaultRegistry();
  const { ctx, stderr } = createTestContext();

  const curl = registry.get("curl")!;
  const result = await curl(["https://example.com"], ctx);

  // Should be blocked
  assertEquals(result.exitCode, 1);

  const errorOutput = await stderr.readAll();
  assertEquals(errorOutput.value.includes("sandboxed execution"), true);
});

Deno.test("test/[ evaluates conditions correctly", async () => {
  const registry = createDefaultRegistry();
  const { vfs, ctx } = createTestContext();

  vfs.writeFile("/file.txt", "data", labels.bottom());
  vfs.mkdir("/dir", false);

  const test = registry.get("test")!;

  // File exists
  let result = await test(["-f", "/file.txt"], ctx);
  assertEquals(result.exitCode, 0);

  // Directory exists
  result = await test(["-d", "/dir"], ctx);
  assertEquals(result.exitCode, 0);

  // File doesn't exist
  result = await test(["-f", "/nonexistent"], ctx);
  assertEquals(result.exitCode, 1);

  // String equality
  result = await test(["hello", "=", "hello"], ctx);
  assertEquals(result.exitCode, 0);

  result = await test(["hello", "=", "world"], ctx);
  assertEquals(result.exitCode, 1);
});

Deno.test("sed transforms with correct label", async () => {
  const registry = createDefaultRegistry();
  const { vfs, ctx, stdout } = createTestContext();

  const fileLabel = labels.userInput();
  vfs.writeFile("/data.txt", "hello world\nhello there", fileLabel);

  const sed = registry.get("sed")!;
  const result = await sed(["s/hello/goodbye/g", "/data.txt"], ctx);

  assertEquals(result.exitCode, 0);

  const output = await stdout.readAll();
  assertEquals(output.value, "goodbye world\ngoodbye there\n");

  // Should have TransformedBy integrity
  const hasTransformed = output.label.integrity.some(a =>
    a.kind === "TransformedBy" && a.command === "sed"
  );
  assertEquals(hasTransformed, true);
});

Deno.test("jq filters JSON with correct label", async () => {
  const registry = createDefaultRegistry();
  const { vfs, ctx, stdout } = createTestContext();

  const json = JSON.stringify({ name: "Alice", age: 30, city: "NYC" });
  const fileLabel = labels.fromFile("/data.json");
  vfs.writeFile("/data.json", json, fileLabel);

  const jq = registry.get("jq")!;
  const result = await jq([".name", "/data.json"], ctx);

  assertEquals(result.exitCode, 0);

  const output = await stdout.readAll();
  const parsed = JSON.parse(output.value);
  assertEquals(parsed, "Alice");

  // Should have TransformedBy integrity
  const hasTransformed = output.label.integrity.some(a =>
    a.kind === "TransformedBy" && a.command === "jq"
  );
  assertEquals(hasTransformed, true);
});

Deno.test("sort preserves data with correct label", async () => {
  const registry = createDefaultRegistry();
  const { ctx, stdout } = createTestContext();

  ctx.stdin = LabeledStream.from({
    value: "zebra\napple\nbanana\n",
    label: labels.userInput(),
  });

  const sort = registry.get("sort")!;
  const result = await sort([], ctx);

  assertEquals(result.exitCode, 0);

  const output = await stdout.readAll();
  assertEquals(output.value, "apple\nbanana\nzebra\n");

  // Should have TransformedBy integrity
  const hasTransformed = output.label.integrity.some(a =>
    a.kind === "TransformedBy" && a.command === "sort"
  );
  assertEquals(hasTransformed, true);
});

Deno.test("mkdir creates directories", async () => {
  const registry = createDefaultRegistry();
  const { vfs, ctx } = createTestContext();

  const mkdir = registry.get("mkdir")!;
  const result = await mkdir(["/new/nested/dir", "-p"], ctx);

  assertEquals(result.exitCode, 0);
  assertEquals(vfs.exists("/new/nested/dir"), true);
});

Deno.test("command registry lists all commands", () => {
  const registry = createDefaultRegistry();
  const commands = registry.list();

  // Check for key commands
  assertEquals(commands.includes("cat"), true);
  assertEquals(commands.includes("grep"), true);
  assertEquals(commands.includes("echo"), true);
  assertEquals(commands.includes("bash"), true);
  assertEquals(commands.includes("curl"), true);
  assertEquals(commands.includes("["), true);

  // Should have around 40+ commands
  assertEquals(commands.length > 40, true);
});
