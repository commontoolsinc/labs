/**
 * Shell Interpreter - walks the AST and executes commands with label propagation
 *
 * Key responsibilities:
 * - Expand words with proper label tracking
 * - Wire pipelines with LabeledStreams
 * - Track implicit flows via PC labels
 * - Handle redirections
 * - Execute control flow (if/for/while)
 */

import {
  Assignment,
  BraceGroup,
  Command,
  ForClause,
  IfClause,
  Pipeline,
  Program,
  Redirection,
  SimpleCommand,
  Subshell,
  WhileClause,
  Word,
  WordPart,
} from "./parser/ast.ts";
import { parse } from "./parser/parser.ts";
import { ShellSession } from "./session.ts";
import { CommandContext, CommandResult } from "./commands/context.ts";
import { LabeledStream } from "./labeled-stream.ts";
import { Labeled, labels } from "./labels.ts";
import { expandGlob } from "./glob.ts";

// ============================================================================
// Loop Control Signals
// ============================================================================

class BreakSignal {
  constructor(public readonly levels: number = 1) {}
}

class ContinueSignal {
  constructor(public readonly levels: number = 1) {}
}

// ============================================================================
// Main Entry Point
// ============================================================================

export function execute(
  input: string,
  session: ShellSession,
): Promise<CommandResult> {
  const ast = parse(input);
  return executeProgram(ast, session);
}

// ============================================================================
// Program Execution (with connectors: &&, ||, ;, &)
// ============================================================================

async function executeProgram(
  node: Program,
  session: ShellSession,
  stdio?: { stdout: LabeledStream; stderr: LabeledStream },
): Promise<CommandResult> {
  let lastResult: CommandResult = {
    exitCode: 0,
    label: labels.bottom(),
  };

  for (const connectedPipeline of node.body) {
    const { pipeline, connector } = connectedPipeline;

    // Execute the pipeline
    lastResult = await executePipeline(pipeline, session, stdio);

    // Update session state
    session.lastExitCode = lastResult.exitCode;
    session.lastExitLabel = lastResult.label;

    // Handle connectors
    if (connector === "&&") {
      // Only continue if last command succeeded
      if (lastResult.exitCode !== 0) {
        break;
      }
    } else if (connector === "||") {
      // Only continue if last command failed
      if (lastResult.exitCode === 0) {
        break;
      }
    } else if (connector === "&") {
      // Background execution - for now, just continue (no true parallelism)
      continue;
    }
    // ";" and undefined: always continue
  }

  return lastResult;
}

// ============================================================================
// Pipeline Execution (commands connected by |)
// ============================================================================

async function executePipeline(
  node: Pipeline,
  session: ShellSession,
  stdio?: { stdout: LabeledStream; stderr: LabeledStream },
): Promise<CommandResult> {
  if (node.commands.length === 0) {
    return { exitCode: 0, label: labels.bottom() };
  }

  // Single command - execute directly with session streams
  if (node.commands.length === 1) {
    const stdin = LabeledStream.empty();
    const stdout = stdio?.stdout ?? new LabeledStream();
    const stderr = stdio?.stderr ?? new LabeledStream();

    const result = await executeCommand(
      node.commands[0],
      session,
      stdin,
      stdout,
      stderr,
    );

    // Close streams only if we created them (not provided by caller)
    if (!stdio?.stdout) {
      stdout.close();
    }
    if (!stdio?.stderr) {
      stderr.close();
    }

    // Apply negation if needed
    if (node.negated) {
      return {
        exitCode: result.exitCode === 0 ? 1 : 0,
        label: result.label,
      };
    }

    return result;
  }

  // Multiple commands - wire them with pipes
  const pipes: LabeledStream[] = [];
  const results: CommandResult[] = [];

  // Create pipes between commands
  for (let i = 0; i < node.commands.length - 1; i++) {
    pipes.push(new LabeledStream());
  }

  // Execute all commands
  for (let i = 0; i < node.commands.length; i++) {
    const command = node.commands[i];

    // Determine stdin
    const stdin = i === 0 ? LabeledStream.empty() : pipes[i - 1];

    // Determine stdout
    const stdout = i === node.commands.length - 1
      ? (stdio?.stdout ?? new LabeledStream())
      : pipes[i];

    // Stderr is per-command
    const stderr = i === node.commands.length - 1
      ? (stdio?.stderr ?? new LabeledStream())
      : new LabeledStream();

    // Execute command
    const result = await executeCommand(
      command,
      session,
      stdin,
      stdout,
      stderr,
    );
    results.push(result);

    // Close pipe streams for intermediate commands so downstream gets EOF.
    // For the last command, only close if we created the stream (not provided by caller).
    if (i !== node.commands.length - 1) {
      // Intermediate command: close the pipe stdout so next command gets EOF
      stdout.close();
      stderr.close();
    } else {
      // Last command: only close if not provided by caller
      if (!stdio?.stdout) {
        stdout.close();
      }
      if (!stdio?.stderr) {
        stderr.close();
      }
    }
  }

  // The pipeline's exit code is the exit code of the last command
  const lastResult = results[results.length - 1];

  // The pipeline's label is the last command's label. Earlier commands'
  // labels flow through the pipe into subsequent commands (which join them
  // into their own labels), but only the last command's output is visible
  // to the caller. This preserves fixedOutputFormat endorsements (e.g.,
  // wc -l at the end of a pipeline keeps InjectionFree).
  const pipelineLabel = lastResult.label;

  // Apply negation if needed
  if (node.negated) {
    return {
      exitCode: lastResult.exitCode === 0 ? 1 : 0,
      label: pipelineLabel,
    };
  }

  return {
    exitCode: lastResult.exitCode,
    label: pipelineLabel,
  };
}

// ============================================================================
// Command Execution (dispatch to specific command types)
// ============================================================================

function executeCommand(
  node: Command,
  session: ShellSession,
  stdin: LabeledStream,
  stdout: LabeledStream,
  stderr: LabeledStream,
): Promise<CommandResult> {
  switch (node.type) {
    case "SimpleCommand":
      return executeSimpleCommand(node, session, stdin, stdout, stderr);
    case "Assignment":
      return executeAssignment(node, session, stdin, stdout, stderr);
    case "IfClause":
      return executeIf(node, session, stdin, stdout, stderr);
    case "ForClause":
      return executeFor(node, session, stdin, stdout, stderr);
    case "WhileClause":
      return executeWhile(node, session, stdin, stdout, stderr);
    case "Subshell":
      return executeSubshell(node, session, stdin, stdout, stderr);
    case "BraceGroup":
      return executeBraceGroup(node, session, stdin, stdout, stderr);
    default:
      throw new Error(`Unknown command type: ${(node as any).type}`);
  }
}

// ============================================================================
// Simple Command Execution
// ============================================================================

async function executeSimpleCommand(
  node: SimpleCommand,
  session: ShellSession,
  stdin: LabeledStream,
  stdout: LabeledStream,
  stderr: LabeledStream,
): Promise<CommandResult> {
  // Handle empty command (redirections only)
  if (!node.name) {
    return { exitCode: 0, label: session.pcLabel };
  }

  // Expand command name
  const expandedName = await expandWord(node.name, session);

  // Handle break/continue as special builtins (they affect loop control flow)
  if (expandedName.value === "break") {
    const levels = node.args.length > 0
      ? parseInt((await expandWord(node.args[0], session)).value, 10) || 1
      : 1;
    throw new BreakSignal(levels);
  }
  if (expandedName.value === "continue") {
    const levels = node.args.length > 0
      ? parseInt((await expandWord(node.args[0], session)).value, 10) || 1
      : 1;
    throw new ContinueSignal(levels);
  }

  // Expand arguments
  const expandedArgs: Labeled<string>[] = [];
  for (const arg of node.args) {
    const expanded = await expandWord(arg, session);
    expandedArgs.push(expanded);
  }

  // Apply redirections
  const {
    stdin: effectiveStdin,
    stdout: effectiveStdout,
    stderr: effectiveStderr,
    flushers,
  } = await applyRedirections(
    node.redirections,
    session,
    stdin,
    stdout,
    stderr,
  );

  // Look up command in registry
  const commandName = expandedName.value;
  const commandFn = session.registry.get(commandName);

  if (!commandFn) {
    // Command not found
    effectiveStderr.write(
      `${commandName}: command not found\n`,
      session.pcLabel,
    );

    // Close streams: always close the ones we're using (effectiveStdout/Stderr),
    // but only if they were created by redirections (different from passed-in).
    // If they're the same as passed-in, the caller owns them.
    if (effectiveStdout !== stdout) {
      effectiveStdout.close();
    }
    if (effectiveStderr !== stderr) {
      effectiveStderr.close();
    }

    // Flush redirections
    for (const flush of flushers) {
      await flush();
    }

    return { exitCode: 127, label: session.pcLabel };
  }

  // Build command context
  const ctx: CommandContext = {
    vfs: session.vfs,
    env: session.env,
    stdin: effectiveStdin,
    stdout: effectiveStdout,
    stderr: effectiveStderr,
    pcLabel: labels.joinAll([
      session.pcLabel,
      expandedName.label,
      ...expandedArgs.map((a) => a.label),
    ]),
    requestIntent: session.requestIntent,
    mockFetch: session.mockFetch,
  };

  // Extract argument values
  const argValues = expandedArgs.map((a) => a.value);

  // Execute command
  const result = await commandFn(argValues, ctx);

  // Join result label with argument labels and PC
  let commandLabel = labels.joinAll([
    result.label,
    expandedName.label,
    ...expandedArgs.map((a) => a.label),
    session.pcLabel,
  ]);

  // Fixed-output-format commands produce structurally safe output (e.g. numbers,
  // fixed strings). The content cannot contain injection regardless of input,
  // so we attest InjectionFree. InfluenceClean is preserved from the join —
  // these are deterministic transforms, not LLMs.
  if (result.fixedOutputFormat) {
    commandLabel = labels.endorse(commandLabel, { kind: "InjectionFree" });
  }

  // Close streams: always close the ones we're using (effectiveStdout/Stderr),
  // but only if they were created by redirections (different from passed-in).
  // If they're the same as passed-in, the caller owns them.
  if (effectiveStdout !== stdout) {
    effectiveStdout.close();
  }
  if (effectiveStderr !== stderr) {
    effectiveStderr.close();
  }

  // Flush redirections
  for (const flush of flushers) {
    await flush();
  }

  return {
    exitCode: result.exitCode,
    label: commandLabel,
  };
}

// ============================================================================
// Word Expansion
// ============================================================================

async function expandWord(
  word: Word,
  session: ShellSession,
): Promise<Labeled<string>> {
  const parts: Labeled<string>[] = [];

  for (const part of word.parts) {
    const expanded = await expandWordPart(part, session);
    parts.push(expanded);
  }

  // Concatenate all parts
  if (parts.length === 0) {
    return { value: "", label: session.pcLabel };
  }

  const value = parts.map((p) => p.value).join("");
  const label = labels.joinAll(parts.map((p) => p.label));

  return { value, label };
}

async function expandWordPart(
  part: WordPart,
  session: ShellSession,
): Promise<Labeled<string>> {
  switch (part.type) {
    case "Literal":
      return { value: part.value, label: session.pcLabel };

    case "SingleQuoted":
      return { value: part.value, label: session.pcLabel };

    case "DoubleQuoted": {
      // Expand inner parts and concatenate
      const innerParts: Labeled<string>[] = [];
      for (const innerPart of part.parts) {
        const expanded = await expandWordPart(innerPart, session);
        innerParts.push(expanded);
      }

      if (innerParts.length === 0) {
        return { value: "", label: session.pcLabel };
      }

      const value = innerParts.map((p) => p.value).join("");
      const label = labels.joinAll(innerParts.map((p) => p.label));

      return { value, label };
    }

    case "VariableExpansion": {
      const varName = part.name;
      const varValue = session.env.get(varName);

      // Handle special variables
      if (varName === "?") {
        return {
          value: String(session.lastExitCode),
          label: session.lastExitLabel,
        };
      }

      // Handle ${VAR:-default}
      if (!varValue && part.op === ":-" && part.arg) {
        const defaultValue = await expandWord(part.arg, session);
        return defaultValue;
      }

      // Variable not set
      if (!varValue) {
        return { value: "", label: session.pcLabel };
      }

      return varValue;
    }

    case "CommandSubstitution": {
      // Execute the command and capture stdout
      if (!part.body) {
        // Failed to parse - return empty
        return { value: "", label: session.pcLabel };
      }

      const substdout = new LabeledStream();
      const substderr = new LabeledStream();

      // Execute program with captured stdout/stderr
      const result = await executeProgram(part.body, session, {
        stdout: substdout,
        stderr: substderr,
      });

      // Close streams
      substdout.close();
      substderr.close();

      // Read all output
      const output = await substdout.readAll();

      // Trim trailing newline (bash behavior)
      let value = output.value;
      if (value.endsWith("\n")) {
        value = value.slice(0, -1);
      }

      // Compute label: join output label with result label.
      // If output is empty (no writes to stdout), output.label is bottom()
      // which would make the join empty. In that case, use result.label alone.
      const outputLabel = output.value.length > 0
        ? labels.join(output.label, result.label)
        : result.label;

      return {
        value,
        label: outputLabel,
      };
    }

    case "ArithmeticExpansion": {
      // Basic arithmetic evaluation
      try {
        const result = evaluateArithmetic(part.expression);
        return { value: String(result), label: session.pcLabel };
      } catch {
        // Arithmetic error - return 0
        return { value: "0", label: session.pcLabel };
      }
    }

    case "Glob": {
      // Expand glob pattern
      const globResult = expandGlob(session.vfs, part.pattern);

      if (globResult.value.length === 0) {
        // No matches - return pattern as-is
        return { value: part.pattern, label: session.pcLabel };
      }

      // Join matches with spaces
      const value = globResult.value.join(" ");
      return { value, label: globResult.label };
    }

    default:
      throw new Error(`Unknown word part type: ${(part as any).type}`);
  }
}

// ============================================================================
// Arithmetic Evaluation (basic)
// ============================================================================

function evaluateArithmetic(expr: string): number {
  // Very basic arithmetic - just handle +, -, *, /, %
  // Remove whitespace
  const clean = expr.replace(/\s/g, "");

  // Try to evaluate as a simple expression
  try {
    // This is a security risk in real code, but for this sandbox it's okay
    // In production, we'd use a proper arithmetic parser
    const result = Function(`"use strict"; return (${clean})`)();
    return Number(result) || 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// Assignment Execution
// ============================================================================

async function executeAssignment(
  node: Assignment,
  session: ShellSession,
  _stdin: LabeledStream,
  _stdout: LabeledStream,
  _stderr: LabeledStream,
): Promise<CommandResult> {
  // Expand the value
  const expandedValue = await expandWord(node.value, session);

  // Set in environment
  session.env.set(node.name, expandedValue.value, expandedValue.label);

  return { exitCode: 0, label: session.pcLabel };
}

// ============================================================================
// If Clause Execution (with PC tracking)
// ============================================================================

async function executeIf(
  node: IfClause,
  session: ShellSession,
  _stdin: LabeledStream,
  _stdout: LabeledStream,
  _stderr: LabeledStream,
): Promise<CommandResult> {
  // Execute condition
  const conditionResult = await executeProgram(node.condition, session);

  // Push condition's label onto PC stack (this taints the branch)
  session.pushPC(conditionResult.label);

  let branchResult: CommandResult;

  if (conditionResult.exitCode === 0) {
    // Execute then branch
    branchResult = await executeProgram(node.then, session);
  } else {
    // Try elifs
    let elifExecuted = false;

    for (const elif of node.elifs) {
      const elifConditionResult = await executeProgram(elif.condition, session);

      if (elifConditionResult.exitCode === 0) {
        branchResult = await executeProgram(elif.then, session);
        elifExecuted = true;
        break;
      }
    }

    // Execute else if present and no elif matched
    if (!elifExecuted && node.else_) {
      branchResult = await executeProgram(node.else_, session);
    } else if (!elifExecuted) {
      branchResult = { exitCode: 0, label: session.pcLabel };
    }
  }

  // Pop PC
  session.popPC();

  return branchResult!;
}

// ============================================================================
// For Loop Execution (with PC tracking)
// ============================================================================

async function executeFor(
  node: ForClause,
  session: ShellSession,
  _stdin: LabeledStream,
  _stdout: LabeledStream,
  _stderr: LabeledStream,
): Promise<CommandResult> {
  // Expand all words in the word list
  const expandedWords: Labeled<string>[] = [];
  for (const word of node.words) {
    const expanded = await expandWord(word, session);
    expandedWords.push(expanded);
  }

  // Join labels of all words (iteration count reveals info about the words)
  const wordsLabel = labels.joinAll(expandedWords.map((w) => w.label));

  // Push PC (the iteration count is tainted by the word list)
  session.pushPC(wordsLabel);

  let lastResult: CommandResult = { exitCode: 0, label: session.pcLabel };

  // Execute body for each word
  for (const word of expandedWords) {
    // Set loop variable
    session.env.set(node.variable, word.value, word.label);

    // Execute body
    try {
      lastResult = await executeProgram(node.body, session);
    } catch (e) {
      if (e instanceof BreakSignal) {
        if (e.levels > 1) throw new BreakSignal(e.levels - 1);
        break;
      }
      if (e instanceof ContinueSignal) {
        if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
        continue;
      }
      throw e;
    }
  }

  // Pop PC
  session.popPC();

  return lastResult;
}

// ============================================================================
// While Loop Execution (with PC tracking)
// ============================================================================

async function executeWhile(
  node: WhileClause,
  session: ShellSession,
  _stdin: LabeledStream,
  _stdout: LabeledStream,
  _stderr: LabeledStream,
): Promise<CommandResult> {
  let lastResult: CommandResult = { exitCode: 0, label: session.pcLabel };
  let iterations = 0;
  const maxIterations = 10000;

  while (iterations < maxIterations) {
    // Execute condition
    const conditionResult = await executeProgram(node.condition, session);

    // Push condition label onto PC
    session.pushPC(conditionResult.label);

    if (conditionResult.exitCode !== 0) {
      // Condition failed - exit loop
      session.popPC();
      break;
    }

    // Execute body
    try {
      lastResult = await executeProgram(node.body, session);
    } catch (e) {
      session.popPC();
      if (e instanceof BreakSignal) {
        if (e.levels > 1) throw new BreakSignal(e.levels - 1);
        break;
      }
      if (e instanceof ContinueSignal) {
        if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
        iterations++;
        continue;
      }
      throw e;
    }

    // Pop PC after body
    session.popPC();

    iterations++;
  }

  if (iterations >= maxIterations) {
    throw new Error("While loop exceeded maximum iterations (10000)");
  }

  return lastResult;
}

// ============================================================================
// Subshell Execution (with environment scope)
// ============================================================================

async function executeSubshell(
  node: Subshell,
  session: ShellSession,
  stdin: LabeledStream,
  stdout: LabeledStream,
  stderr: LabeledStream,
): Promise<CommandResult> {
  // Apply redirections on the subshell itself
  const {
    stdin: _effectiveStdin,
    stdout: effectiveStdout,
    stderr: effectiveStderr,
    flushers,
  } = await applyRedirections(
    node.redirections,
    session,
    stdin,
    stdout,
    stderr,
  );

  // Push environment scope
  session.env.pushScope();

  // Execute body with effective stdio
  const result = await executeProgram(node.body, session, {
    stdout: effectiveStdout,
    stderr: effectiveStderr,
  });

  // Pop environment scope
  session.env.popScope();

  // Close redirected streams and flush redirections
  if (node.redirections.length > 0) {
    effectiveStdout.close();
    effectiveStderr.close();

    for (const flush of flushers) {
      await flush();
    }
  }

  return result;
}

// ============================================================================
// Brace Group Execution (no environment scope)
// ============================================================================

function executeBraceGroup(
  node: BraceGroup,
  session: ShellSession,
  _stdin: LabeledStream,
  _stdout: LabeledStream,
  _stderr: LabeledStream,
): Promise<CommandResult> {
  // Execute body in current scope
  return executeProgram(node.body, session);
}

// ============================================================================
// Redirection Handling
// ============================================================================

type Flusher = () => Promise<void>;

interface RedirectionResult {
  stdin: LabeledStream;
  stdout: LabeledStream;
  stderr: LabeledStream;
  flushers: Flusher[];
}

async function applyRedirections(
  redirections: Redirection[],
  session: ShellSession,
  stdin: LabeledStream,
  stdout: LabeledStream,
  stderr: LabeledStream,
): Promise<RedirectionResult> {
  let effectiveStdin = stdin;
  let effectiveStdout = stdout;
  let effectiveStderr = stderr;
  const flushers: Flusher[] = [];

  for (const redir of redirections) {
    const target = await expandWord(redir.target, session);
    const targetPath = target.value;

    switch (redir.op) {
      case "<": {
        // Input redirection - read from file
        try {
          const fileContent = session.vfs.readFileText(targetPath);
          effectiveStdin = LabeledStream.from(fileContent);
        } catch {
          // File not found - create empty stream
          effectiveStdin = LabeledStream.empty();
        }
        break;
      }

      case ">": {
        // Output redirection - write to file (truncate)
        const captureStream = new LabeledStream();
        effectiveStdout = captureStream;

        flushers.push(async () => {
          const output = await captureStream.readAll();
          // Taint confidentiality with PC (preserve output's integrity)
          const writeLabel = labels.taintConfidentiality(
            output.label,
            session.pcLabel,
          );
          session.vfs.writeFile(targetPath, output.value, writeLabel);
        });
        break;
      }

      case ">>": {
        // Output redirection - append to file
        const captureStream = new LabeledStream();
        effectiveStdout = captureStream;

        flushers.push(async () => {
          const output = await captureStream.readAll();

          // Read existing content if file exists
          let existingContent = "";
          let existingLabel = labels.bottom();

          try {
            const existing = session.vfs.readFileText(targetPath);
            existingContent = existing.value;
            existingLabel = existing.label;
          } catch {
            // File doesn't exist - that's okay
          }

          // Append new content; taint confidentiality with PC (preserve integrity)
          const newContent = existingContent + output.value;
          const combinedLabel = labels.join(existingLabel, output.label);
          const newLabel = labels.taintConfidentiality(
            combinedLabel,
            session.pcLabel,
          );

          session.vfs.writeFile(targetPath, newContent, newLabel);
        });
        break;
      }

      case "2>": {
        // Stderr redirection - write to file (truncate)
        const captureStream = new LabeledStream();
        effectiveStderr = captureStream;

        flushers.push(async () => {
          const output = await captureStream.readAll();
          const writeLabel = labels.taintConfidentiality(
            output.label,
            session.pcLabel,
          );
          session.vfs.writeFile(targetPath, output.value, writeLabel);
        });
        break;
      }

      case "2>>": {
        // Stderr redirection - append to file
        const captureStream = new LabeledStream();
        effectiveStderr = captureStream;

        flushers.push(async () => {
          const output = await captureStream.readAll();

          // Read existing content if file exists
          let existingContent = "";
          let existingLabel = labels.bottom();

          try {
            const existing = session.vfs.readFileText(targetPath);
            existingContent = existing.value;
            existingLabel = existing.label;
          } catch {
            // File doesn't exist - that's okay
          }

          // Append new content; taint confidentiality with PC (preserve integrity)
          const newContent = existingContent + output.value;
          const combinedLabel = labels.join(existingLabel, output.label);
          const newLabel = labels.taintConfidentiality(
            combinedLabel,
            session.pcLabel,
          );

          session.vfs.writeFile(targetPath, newContent, newLabel);
        });
        break;
      }

      case "&>": {
        // Redirect both stdout and stderr to file
        const captureStream = new LabeledStream();
        effectiveStdout = captureStream;
        effectiveStderr = captureStream;

        flushers.push(async () => {
          const output = await captureStream.readAll();
          const writeLabel = labels.taintConfidentiality(
            output.label,
            session.pcLabel,
          );
          session.vfs.writeFile(targetPath, output.value, writeLabel);
        });
        break;
      }

      case "<<": {
        // Here-document - use target as content
        const heredocContent = targetPath;
        effectiveStdin = LabeledStream.from({
          value: heredocContent + "\n",
          label: session.pcLabel,
        });
        break;
      }
    }
  }

  return {
    stdin: effectiveStdin,
    stdout: effectiveStdout,
    stderr: effectiveStderr,
    flushers,
  };
}
