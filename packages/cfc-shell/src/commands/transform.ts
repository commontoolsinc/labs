/**
 * Transform commands: sed, sort, uniq, cut, tr, jq, base64
 */

import type { CommandContext, CommandResult } from "./context.ts";
import { labels } from "../labels.ts";

/**
 * sed - stream editor (basic s command only)
 */
export async function sed(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length === 0) {
    ctx.stderr.write("sed: missing script\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const script = args[0];
  const file = args[1];

  // Parse s/pattern/replacement/flags
  const match = script.match(/^s\/(.*)\/(.*)\/([gp]*)$/);
  if (!match) {
    ctx.stderr.write(`sed: unsupported script: ${script}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const [, pattern, replacement, flags] = match;
  const global = flags.includes("g");

  try {
    let content: string;
    let inputLabel;

    if (file) {
      ({ value: content, label: inputLabel } = ctx.vfs.readFileText(file));
    } else {
      ({ value: content, label: inputLabel } = await ctx.stdin.readAll());
    }

    const regex = new RegExp(pattern, global ? "g" : "");
    const output = content.split("\n")
      .map(line => line.replace(regex, replacement))
      .join("\n");

    // Output inherits input confidentiality, gets TransformedBy integrity
    const outputLabel = labels.endorse(inputLabel, { kind: "TransformedBy", command: "sed" });

    ctx.stdout.write(output, outputLabel);

    return { exitCode: 0, label: outputLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`sed: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

/**
 * sort - sort lines
 */
export async function sort(args: string[], ctx: CommandContext): Promise<CommandResult> {
  let reverse = false;
  let numeric = false;
  let keyField: number | null = null;
  let file: string | null = null;

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-r") {
      reverse = true;
    } else if (arg === "-n") {
      numeric = true;
    } else if (arg === "-k" && i + 1 < args.length) {
      keyField = parseInt(args[i + 1], 10) - 1;
      i++;
    } else if (!arg.startsWith("-")) {
      file = arg;
    }
  }

  try {
    let content: string;
    let inputLabel;

    if (file) {
      ({ value: content, label: inputLabel } = ctx.vfs.readFileText(file));
    } else {
      ({ value: content, label: inputLabel } = await ctx.stdin.readAll());
    }

    let lines = content.split("\n").filter(l => l.length > 0);

    lines.sort((a, b) => {
      let aVal = a;
      let bVal = b;

      if (keyField !== null) {
        aVal = a.split(/\s+/)[keyField] || "";
        bVal = b.split(/\s+/)[keyField] || "";
      }

      if (numeric) {
        const aNum = parseFloat(aVal);
        const bNum = parseFloat(bVal);
        return reverse ? bNum - aNum : aNum - bNum;
      } else {
        return reverse ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
      }
    });

    const outputLabel = labels.endorse(inputLabel, { kind: "TransformedBy", command: "sort" });

    ctx.stdout.write(lines.join("\n") + (lines.length > 0 ? "\n" : ""), outputLabel);

    return { exitCode: 0, label: outputLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`sort: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

/**
 * uniq - deduplicate adjacent lines
 */
export async function uniq(args: string[], ctx: CommandContext): Promise<CommandResult> {
  let showCount = false;
  let file: string | null = null;

  // Parse args
  for (const arg of args) {
    if (arg === "-c") {
      showCount = true;
    } else if (!arg.startsWith("-")) {
      file = arg;
    }
  }

  try {
    let content: string;
    let inputLabel;

    if (file) {
      ({ value: content, label: inputLabel } = ctx.vfs.readFileText(file));
    } else {
      ({ value: content, label: inputLabel } = await ctx.stdin.readAll());
    }

    const lines = content.split("\n");
    const output: string[] = [];
    let lastLine = "";
    let count = 0;

    for (const line of lines) {
      if (line === lastLine) {
        count++;
      } else {
        if (lastLine !== "") {
          const prefix = showCount ? `${count.toString().padStart(7)} ` : "";
          output.push(prefix + lastLine);
        }
        lastLine = line;
        count = 1;
      }
    }

    if (lastLine !== "") {
      const prefix = showCount ? `${count.toString().padStart(7)} ` : "";
      output.push(prefix + lastLine);
    }

    const outputLabel = labels.endorse(inputLabel, { kind: "TransformedBy", command: "uniq" });

    ctx.stdout.write(output.join("\n"), outputLabel);

    return { exitCode: 0, label: outputLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`uniq: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

/**
 * cut - extract fields
 */
export async function cut(args: string[], ctx: CommandContext): Promise<CommandResult> {
  let delimiter = "\t";
  let fields: number[] = [];
  let file: string | null = null;

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-d" && i + 1 < args.length) {
      delimiter = args[i + 1];
      i++;
    } else if (arg === "-f" && i + 1 < args.length) {
      fields = args[i + 1].split(",").map(f => parseInt(f, 10) - 1);
      i++;
    } else if (!arg.startsWith("-")) {
      file = arg;
    }
  }

  if (fields.length === 0) {
    ctx.stderr.write("cut: you must specify a list of fields\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  try {
    let content: string;
    let inputLabel;

    if (file) {
      ({ value: content, label: inputLabel } = ctx.vfs.readFileText(file));
    } else {
      ({ value: content, label: inputLabel } = await ctx.stdin.readAll());
    }

    const output = content.split("\n")
      .map(line => {
        const parts = line.split(delimiter);
        return fields.map(f => parts[f] || "").join(delimiter);
      })
      .join("\n");

    const outputLabel = labels.endorse(inputLabel, { kind: "TransformedBy", command: "cut" });

    ctx.stdout.write(output, outputLabel);

    return { exitCode: 0, label: outputLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`cut: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

/**
 * tr - character translation
 */
export async function tr(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length < 2) {
    ctx.stderr.write("tr: missing operand\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const set1 = args[0];
  const set2 = args[1];

  try {
    const { value: content, label: inputLabel } = await ctx.stdin.readAll();

    const output = content.split("").map(char => {
      const idx = set1.indexOf(char);
      return idx >= 0 && idx < set2.length ? set2[idx] : char;
    }).join("");

    const outputLabel = labels.endorse(inputLabel, { kind: "TransformedBy", command: "tr" });

    ctx.stdout.write(output, outputLabel);

    return { exitCode: 0, label: outputLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`tr: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

/**
 * jq - JSON query
 * Supports: .key, .key.subkey, .[], .[N], .key[], |, and identity .
 */
export async function jq(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length === 0) {
    ctx.stderr.write("jq: missing filter\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  const filter = args[0];
  const file = args[1];

  try {
    let content: string;
    let inputLabel;

    if (file) {
      ({ value: content, label: inputLabel } = ctx.vfs.readFileText(file));
    } else {
      ({ value: content, label: inputLabel } = await ctx.stdin.readAll());
    }

    const data = JSON.parse(content);
    const result = applyJqFilter(data, filter);

    const outputLabel = labels.endorse(inputLabel, { kind: "TransformedBy", command: "jq" });

    ctx.stdout.write(JSON.stringify(result, null, 2) + "\n", outputLabel);

    return { exitCode: 0, label: outputLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`jq: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}

function applyJqFilter(data: any, filter: string): any {
  // Handle pipe
  if (filter.includes("|")) {
    const parts = filter.split("|").map(p => p.trim());
    return parts.reduce((acc, part) => applyJqFilter(acc, part), data);
  }

  // Identity
  if (filter === ".") {
    return data;
  }

  // Array iteration: .[]
  if (filter === ".[]") {
    return Array.isArray(data) ? data : Object.values(data);
  }

  // Array index: .[N]
  const arrayIndexMatch = filter.match(/^\.\[(\d+)\]$/);
  if (arrayIndexMatch) {
    const index = parseInt(arrayIndexMatch[1], 10);
    return Array.isArray(data) ? data[index] : undefined;
  }

  // Key access with array iteration: .key[]
  const keyArrayMatch = filter.match(/^\.([a-zA-Z_][a-zA-Z0-9_]*)\[\]$/);
  if (keyArrayMatch) {
    const key = keyArrayMatch[1];
    const value = data?.[key];
    return Array.isArray(value) ? value : Object.values(value ?? {});
  }

  // Key access: .key or .key.subkey
  if (filter.startsWith(".")) {
    const keys = filter.slice(1).split(".");
    return keys.reduce((acc, key) => acc?.[key], data);
  }

  return data;
}

/**
 * base64 - encode/decode base64
 */
export async function base64(args: string[], ctx: CommandContext): Promise<CommandResult> {
  let decode = false;
  let file: string | null = null;

  // Parse args
  for (const arg of args) {
    if (arg === "-d" || arg === "--decode") {
      decode = true;
    } else if (!arg.startsWith("-")) {
      file = arg;
    }
  }

  try {
    let content: string;
    let inputLabel;

    if (file) {
      ({ value: content, label: inputLabel } = ctx.vfs.readFileText(file));
    } else {
      ({ value: content, label: inputLabel } = await ctx.stdin.readAll());
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let output: string;
    if (decode) {
      const binary = Uint8Array.from(atob(content.trim()), c => c.charCodeAt(0));
      output = decoder.decode(binary);
    } else {
      const binary = encoder.encode(content);
      output = btoa(String.fromCharCode(...binary));
    }

    const outputLabel = labels.endorse(inputLabel, { kind: "TransformedBy", command: "base64" });

    ctx.stdout.write(output + "\n", outputLabel);

    return { exitCode: 0, label: outputLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`base64: ${message}\n`, ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }
}
