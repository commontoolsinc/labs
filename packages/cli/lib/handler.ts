import { encode } from "@commontools/utils/encoding";
import { red } from "@std/fmt/colors";

export interface JSONFlag {
  json?: true;
}

export interface VerboseFlag {
  verbose?: true;
}

// The primary handler to wrap @cliffy/command actions,
// handling command output, errors and exit codes.
// Every action in a command must await this function,
// rendering the result of the promise as the primary output,
// or the rejection when failed.
//
// The return value of `Command#parse` is a `CommandResult`,
// and does not contain (AFAIK) the return value of the
// action invoked by a command, where this would be more
// easily implemented. Instead, this must be called by
// each action.
// @TODO Handle json
// @TODO Handle verbose
export async function handleCommand(
  promise: unknown,
  opts: JSONFlag & VerboseFlag = {},
) {
  if (opts.json) {
    throw new Error("JSON mode not yet supported.");
  }
  try {
    // Most commands will send in promises, but can
    // be any type.
    const value = await promise;
    render(value, opts);
    Deno.exit(0);
  } catch (e: unknown) {
    renderError(e, opts);
    Deno.exit(1);
  }
}

// Log to stdout
export function verboseLog(
  message: string,
  opts: JSONFlag & VerboseFlag,
) {
  if (opts.verbose) {
    render(message, opts);
  }
}

export function verboseError(
  message: string,
  opts: JSONFlag & VerboseFlag = {},
) {
  if (opts.verbose) {
    renderError(message, opts);
  }
}

function stringify(value: unknown): string {
  switch (typeof value) {
    case "object": {
      if (!value) return "null";
      if (
        value instanceof ArrayBuffer ||
        ("buffer" in value && value.buffer instanceof ArrayBuffer)
      ) {
        // All commands operate over text rather than binary
        throw new Error("Binary data could not be stringified");
      }
      try {
        return JSON.stringify(value, null, 2);
        // deno-lint-ignore no-empty
      } catch (_) {}
      return value.toString();
    }
    case "function":
      throw new Error("Function could not be stringified");
    case "symbol":
      return value.toString();
    case "undefined":
      return "";
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    default:
      return `${value}`;
  }
}

// https://jsr.io/@std/io/doc/types/~/WriterSync
interface WriterSync {
  writeSync(p: Uint8Array): number;
}

// Renders the primary output of a command to stdout.
// @TODO Handle json
function render(
  value: unknown,
  opts: JSONFlag = {},
) {
  innerRender(value, Deno.stdout, opts);
}

function renderError(
  value: unknown,
  opts: JSONFlag & VerboseFlag = {},
) {
  let message, stack;
  if (value instanceof Error) {
    message = value.message;
    stack = value.stack;
  } else if (typeof value === "string") {
    message = value;
  } else {
    message = String(value);
  }
  innerRender(red(message), Deno.stderr, opts);
  if (opts.verbose && stack) {
    innerRender(red(stack), Deno.stderr, opts);
  }
}

function innerRender(
  value: unknown,
  writer: WriterSync,
  opts: JSONFlag = {},
) {
  if (typeof value === "undefined") {
    return;
  }
  if (opts.json) {
    throw new Error("JSON mode not yet supported.");
  }
  // Append a `\n` to the stdout for TTY legibility and
  // unix file compatibility.
  const stringValue = `${stringify(value)}\n`;
  writer.writeSync(encode(stringValue));
}
