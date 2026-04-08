import {
  type CallableExecutionDeps,
  type CallableResolution,
  executeResolvedCallable,
} from "./callable.ts";
import {
  type ExecCommandSpec,
  type ExecInputResolverDeps,
  normalizeCallableInputForExecution,
  type ParsedExecArgs,
  resolveExecInvocation,
} from "./exec-schema.ts";

export interface CallableCommandExecutionResult<TResolved> {
  helpText?: string;
  outputText?: string;
  parsed: ParsedExecArgs;
  resolved: TResolved;
}

export interface CallableCommandExecutionOptions<
  TResolved,
  TDeps extends CallableExecutionDeps & ExecInputResolverDeps,
> {
  resolved: TResolved;
  execution: CallableResolution;
  commandSpec: ExecCommandSpec;
  rawArgs: string[];
  deps?: TDeps;
  renderHelp: (commandSpec: ExecCommandSpec, parsed: ParsedExecArgs) => string;
  validateRawArgs?: (
    rawArgs: string[],
    commandSpec: ExecCommandSpec,
    resolved: TResolved,
  ) => void;
}

export async function readJsonInputFromStdin(): Promise<unknown> {
  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();
  let sawChunk = false;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sawChunk = true;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  if (!sawChunk && text.trim().length === 0) {
    throw new Error("Expected JSON on stdin for --json");
  }

  if (text.trim().length === 0) {
    throw new Error("Expected JSON on stdin for --json");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON on stdin for --json");
  }
}

export async function executeCallableCommand<
  TResolved,
  TDeps extends CallableExecutionDeps & ExecInputResolverDeps,
>(
  options: CallableCommandExecutionOptions<TResolved, TDeps>,
): Promise<CallableCommandExecutionResult<TResolved>> {
  const {
    resolved,
    execution,
    commandSpec,
    rawArgs,
    deps,
    renderHelp,
    validateRawArgs,
  } = options;

  validateRawArgs?.(rawArgs, commandSpec, resolved);

  const invocation = await resolveExecInvocation(commandSpec, rawArgs, deps);
  const parsed = invocation.parsed;

  if (parsed.showHelp) {
    return {
      helpText: renderHelp(commandSpec, parsed),
      parsed,
      resolved,
    };
  }

  const input = invocation.input;

  const executed = await executeResolvedCallable(
    execution,
    parsed.usedJsonInput
      ? input
      : normalizeCallableInputForExecution(commandSpec, input),
    deps,
  );

  return {
    outputText: executed.outputText,
    parsed,
    resolved,
  };
}
