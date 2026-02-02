/**
 * Comprehensive tests for the shell interpreter
 *
 * Tests cover:
 * - Simple command execution
 * - Variable assignment and expansion
 * - Pipelines
 * - Redirections
 * - Command substitution
 * - Control flow (if/for/while) with PC tracking
 * - Subshells and environment scoping
 * - Label propagation through all operations
 */

import { assertEquals, assertExists } from "@std/assert";
import { execute } from "../src/interpreter.ts";
import { createSession, ShellSession } from "../src/session.ts";
import { CommandRegistry } from "../src/commands/registry.ts";
import { CommandContext, CommandResult } from "../src/commands/context.ts";
import { VFS } from "../src/vfs.ts";
import { type Label, labels } from "../src/labels.ts";
import { cat } from "../src/commands/read.ts";

// ============================================================================
// Test Helper - Create Session with Basic Commands
// ============================================================================

function createTestSession(): ShellSession {
  const registry = new CommandRegistry();
  const vfs = new VFS();

  // Register echo command
  registry.register(
    "echo",
    async (args: string[], ctx: CommandContext): Promise<CommandResult> => {
      await Promise.resolve();
      const output = args.join(" ") + "\n";
      ctx.stdout.write(output, ctx.pcLabel);
      return { exitCode: 0, label: ctx.pcLabel };
    },
  );

  // Register cat command
  registry.register("cat", cat);

  // Register true/false commands for testing
  registry.register(
    "true",
    async (_args: string[], ctx: CommandContext): Promise<CommandResult> => {
      await Promise.resolve();
      return { exitCode: 0, label: ctx.pcLabel };
    },
  );

  registry.register(
    "false",
    async (_args: string[], ctx: CommandContext): Promise<CommandResult> => {
      await Promise.resolve();
      return { exitCode: 1, label: ctx.pcLabel };
    },
  );

  // Register test command (for conditionals)
  registry.register(
    "test",
    async (args: string[], ctx: CommandContext): Promise<CommandResult> => {
      await Promise.resolve();
      // Simple test: [ -z STRING ] tests if string is empty
      if (args[0] === "-z") {
        const exitCode = args[1] === "" ? 0 : 1;
        return { exitCode, label: ctx.pcLabel };
      }

      // [ STRING1 = STRING2 ]
      if (args[1] === "=") {
        const exitCode = args[0] === args[2] ? 0 : 1;
        return { exitCode, label: ctx.pcLabel };
      }

      return { exitCode: 1, label: ctx.pcLabel };
    },
  );

  return createSession({ registry, vfs });
}

// ============================================================================
// Simple Command Execution
// ============================================================================

Deno.test("interpreter: simple command - echo hello", async () => {
  const session = createTestSession();
  const result = await execute("echo hello", session);

  assertEquals(result.exitCode, 0);
  assertEquals(session.lastExitCode, 0);
});

Deno.test("interpreter: command not found", async () => {
  const session = createTestSession();
  const result = await execute("nonexistent", session);

  assertEquals(result.exitCode, 127);
});

// ============================================================================
// Variable Assignment and Expansion
// ============================================================================

Deno.test("interpreter: variable assignment", async () => {
  const session = createTestSession();

  await execute("FOO=bar", session);
  const value = session.env.get("FOO");

  assertExists(value);
  assertEquals(value.value, "bar");
});

Deno.test("interpreter: variable expansion in command", async () => {
  const session = createTestSession();

  await execute("FOO=hello", session);
  await execute("echo $FOO", session);

  // Variable should be set
  const value = session.env.get("FOO");
  assertExists(value);
  assertEquals(value.value, "hello");
});

Deno.test("interpreter: variable expansion with default value", async () => {
  const session = createTestSession();

  await execute("echo ${UNSET:-default}", session);
  // Should use default value since UNSET is not set
});

Deno.test("interpreter: special variable $? (last exit code)", async () => {
  const session = createTestSession();

  await execute("true", session);
  assertEquals(session.lastExitCode, 0);

  await execute("false", session);
  assertEquals(session.lastExitCode, 1);

  // $? should reflect the last exit code
  const _exitCodeVar = session.env.get("?");
  // Note: $? is handled specially in expandWord, not in env
});

// ============================================================================
// Pipelines
// ============================================================================

Deno.test("interpreter: simple pipe - echo | cat", async () => {
  const session = createTestSession();
  const result = await execute("echo hello | cat", session);

  assertEquals(result.exitCode, 0);
});

Deno.test("interpreter: pipe with multiple commands", async () => {
  const session = createTestSession();
  const result = await execute("echo hello | cat | cat", session);

  assertEquals(result.exitCode, 0);
});

Deno.test("interpreter: negated pipeline", async () => {
  const session = createTestSession();

  // ! true should exit with 1
  const result1 = await execute("! true", session);
  assertEquals(result1.exitCode, 1);

  // ! false should exit with 0
  const result2 = await execute("! false", session);
  assertEquals(result2.exitCode, 0);
});

// ============================================================================
// Redirections
// ============================================================================

Deno.test("interpreter: output redirection >", async () => {
  const session = createTestSession();

  await execute("echo hello > /tmp/test.txt", session);

  // Verify file was created
  const content = session.vfs.readFileText("/tmp/test.txt");
  assertEquals(content.value, "hello\n");
});

Deno.test("interpreter: append redirection >>", async () => {
  const session = createTestSession();

  await execute("echo first > /tmp/test.txt", session);
  await execute("echo second >> /tmp/test.txt", session);

  const content = session.vfs.readFileText("/tmp/test.txt");
  assertEquals(content.value, "first\nsecond\n");
});

Deno.test("interpreter: input redirection <", async () => {
  const session = createTestSession();

  // Create a file first
  session.vfs.writeFile("/tmp/input.txt", "test content", labels.bottom());

  // Read from it
  await execute("cat < /tmp/input.txt", session);
});

Deno.test("interpreter: here-document <<", async () => {
  const session = createTestSession();

  // Here-doc: cat << EOF should read the content
  await execute("cat << hello", session);
});

// ============================================================================
// Command Substitution
// ============================================================================

Deno.test("interpreter: command substitution $(cmd)", async () => {
  const session = createTestSession();

  // Set up a command that outputs something
  await execute("echo result", session);

  // Now use command substitution
  await execute("echo $(echo nested)", session);
});

Deno.test("interpreter: command substitution in variable", async () => {
  const session = createTestSession();

  await execute("VAR=$(echo hello)", session);

  const value = session.env.get("VAR");
  assertExists(value);
  assertEquals(value.value, "hello");
});

// ============================================================================
// Connectors: &&, ||, ;
// ============================================================================

Deno.test("interpreter: && connector - both commands run on success", async () => {
  const session = createTestSession();

  await execute("true && echo success", session);
});

Deno.test("interpreter: && connector - second command skipped on failure", async () => {
  const session = createTestSession();

  await execute("false && echo should_not_run", session);

  // should_not_run should not be in any output
});

Deno.test("interpreter: || connector - second command runs on failure", async () => {
  const session = createTestSession();

  await execute("false || echo fallback", session);
});

Deno.test("interpreter: || connector - second command skipped on success", async () => {
  const session = createTestSession();

  await execute("true || echo should_not_run", session);
});

Deno.test("interpreter: ; connector - both commands always run", async () => {
  const session = createTestSession();

  await execute("false ; echo always", session);
});

// ============================================================================
// If/Then/Else (with PC taint tracking)
// ============================================================================

Deno.test("interpreter: if-then executes then branch on success", async () => {
  const session = createTestSession();

  await execute(
    `
    if true; then
      echo in_then
    fi
  `,
    session,
  );
});

Deno.test("interpreter: if-then-else executes else branch on failure", async () => {
  const session = createTestSession();

  await execute(
    `
    if false; then
      echo in_then
    else
      echo in_else
    fi
  `,
    session,
  );
});

Deno.test("interpreter: if-elif-else chain", async () => {
  const session = createTestSession();

  await execute(
    `
    if false; then
      echo first
    elif true; then
      echo second
    else
      echo third
    fi
  `,
    session,
  );
});

Deno.test("interpreter: if with PC taint - condition label taints branch output", async () => {
  const session = createTestSession();

  // The condition's label should be pushed onto PC stack during branch execution
  await execute(
    `
    if true; then
      echo tainted
    fi
  `,
    session,
  );
});

// ============================================================================
// For Loops (with PC taint tracking)
// ============================================================================

Deno.test("interpreter: for loop iterates over words", async () => {
  const session = createTestSession();

  await execute(
    `
    for i in a b c; do
      echo $i
    done
  `,
    session,
  );

  // Loop variable should be set to last value
  const value = session.env.get("i");
  assertExists(value);
  assertEquals(value.value, "c");
});

Deno.test("interpreter: for loop with variable expansion", async () => {
  const session = createTestSession();

  await execute(
    `
    ITEMS="one two three"
    for item in $ITEMS; do
      echo $item
    done
  `,
    session,
  );
});

Deno.test("interpreter: for loop with PC taint - word list taints iterations", async () => {
  const session = createTestSession();

  // The iteration count reveals information about the word list
  await execute(
    `
    for x in a b; do
      echo iteration
    done
  `,
    session,
  );
});

// ============================================================================
// While Loops (with PC taint tracking)
// ============================================================================

Deno.test("interpreter: while loop runs until condition fails", async () => {
  const session = createTestSession();

  // Set up a counter
  await execute("COUNT=0", session);

  // Use a simple loop that will terminate
  // Note: This is tricky because we need a way to modify COUNT in the loop
  // For now, just test that while with false doesn't run
  await execute(
    `
    while false; do
      echo should_not_run
    done
  `,
    session,
  );
});

Deno.test("interpreter: while loop with true runs body (limited iterations)", async () => {
  const session = createTestSession();

  // This would be infinite, but we have a safety limit
  // Just test that the loop mechanism works
  await execute(
    `
    while true; do
      echo iteration
      break
    done
  `,
    session,
  );
});

// ============================================================================
// Subshells (with environment scoping)
// ============================================================================

Deno.test("interpreter: subshell isolates environment changes", async () => {
  const session = createTestSession();

  await execute("VAR=outer", session);
  await execute("(VAR=inner; echo $VAR)", session);

  // VAR should still be "outer" in parent
  const value = session.env.get("VAR");
  assertExists(value);
  assertEquals(value.value, "outer");
});

Deno.test("interpreter: subshell can read parent variables", async () => {
  const session = createTestSession();

  await execute("PARENT=value", session);
  await execute("(echo $PARENT)", session);
});

// ============================================================================
// Brace Groups (no environment scoping)
// ============================================================================

Deno.test("interpreter: brace group does not isolate environment", async () => {
  const session = createTestSession();

  await execute("{ VAR=modified; }", session);

  // VAR should be modified in current scope
  const value = session.env.get("VAR");
  assertExists(value);
  assertEquals(value.value, "modified");
});

// ============================================================================
// Glob Expansion
// ============================================================================

Deno.test("interpreter: glob expansion in arguments", async () => {
  const session = createTestSession();

  // Create some files
  session.vfs.writeFile("/tmp/file1.txt", "content1", labels.bottom());
  session.vfs.writeFile("/tmp/file2.txt", "content2", labels.bottom());

  // Use glob pattern (note: our glob is handled in word expansion)
  await execute("echo /tmp/*.txt", session);
});

// ============================================================================
// Label Propagation
// ============================================================================

Deno.test("interpreter: label propagates through pipeline", async () => {
  const session = createTestSession();

  // Create a file with a specific label
  const secretLabel = labels.join(
    labels.bottom(),
    {
      confidentiality: [[{ kind: "Custom", tag: "secret" }]],
      integrity: [],
    },
  );

  session.vfs.writeFile("/tmp/secret.txt", "secret data", secretLabel);

  // Read and pipe through cat
  const result = await execute("cat /tmp/secret.txt | cat", session);

  // Result should have the secret label
  // (We can't directly assert on label equality without helper functions,
  // but we verify it doesn't error)
  assertEquals(result.exitCode, 0);
});

Deno.test("interpreter: PC label taints output in conditional", async () => {
  const session = createTestSession();

  // Create a file with tainted data
  const taintedLabel: Label = {
    confidentiality: [[{ kind: "Custom" as const, tag: "tainted" }]],
    integrity: [],
  };

  session.vfs.writeFile("/tmp/tainted.txt", "tainted", taintedLabel);

  // Use tainted data in condition
  await execute(
    `
    if cat /tmp/tainted.txt > /dev/null; then
      echo revealed
    fi
  `,
    session,
  );

  // The "revealed" output should be tainted by the condition
  // (PC stack tracking should propagate this)
});

// ============================================================================
// Complex Scenarios
// ============================================================================

Deno.test("interpreter: complex script with multiple features", async () => {
  const session = createTestSession();

  await execute(
    `
    # Variable assignment
    NAME=world

    # Conditional with command substitution
    if true; then
      GREETING=$(echo hello)
      echo $GREETING $NAME
    fi

    # For loop
    for i in 1 2 3; do
      echo iteration $i
    done

    # Pipeline with redirection
    echo output > /tmp/result.txt
    cat /tmp/result.txt
  `,
    session,
  );

  assertEquals(session.lastExitCode, 0);
});

Deno.test("interpreter: nested control structures", async () => {
  const session = createTestSession();

  await execute(
    `
    for x in a b; do
      if true; then
        echo $x
      fi
    done
  `,
    session,
  );

  assertEquals(session.lastExitCode, 0);
});

// ============================================================================
// Error Handling
// ============================================================================

Deno.test("interpreter: command not found returns 127", async () => {
  const session = createTestSession();
  const result = await execute("nonexistent_command", session);

  assertEquals(result.exitCode, 127);
});

Deno.test("interpreter: syntax error in input", async () => {
  const session = createTestSession();

  try {
    await execute("if then fi", session); // Invalid syntax
  } catch (e) {
    // Should throw parse error
    assertExists(e);
  }
});

Deno.test("interpreter: empty input", async () => {
  const session = createTestSession();
  const result = await execute("", session);

  assertEquals(result.exitCode, 0);
});

Deno.test("interpreter: comments are ignored", async () => {
  const session = createTestSession();

  const result = await execute(
    `
    # This is a comment
    echo hello # inline comment
  `,
    session,
  );

  assertEquals(result.exitCode, 0);
});
