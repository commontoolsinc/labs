#!/usr/bin/env -S deno run --allow-read --allow-write
import { fromFileUrl } from "@std/path";
import { SANDBOX_WITHHELD_GLOBALS } from "@commonfabric/utils/sandbox-contract";

/**
 * Removes the declaration of each global a sandbox compartment does not
 * provide, so the pattern compiler stops offering names that throw at runtime.
 *
 * Only the value declaration goes. The matching `interface` stays, so a
 * pattern can still write `let bytes: Float32Array` — it just cannot reach the
 * constructor. `new Float32Array()` becomes "'Float32Array' only refers to a
 * type, but is being used as a value here" at compile time. A name with no
 * same-named interface, such as `Proxy`, gives "Cannot find name" instead.
 *
 * Three declaration shapes appear in TypeScript's libraries; two are handled
 * here: the one-line `declare var Atomics: Atomics;` or
 * `declare function setTimeout(...): number;`, and the braced
 * `declare var Blob: { ... };`. The third, `declare namespace Intl { ... }`,
 * mixes types and values, so removing it whole would take the types with it.
 * `stillDeclared` fails the run rather than let a name this cannot strip be
 * reported as stripped.
 *
 * Every other byte is preserved, including each line's original ending,
 * because `es2023.d.ts` is CRLF and `dom.d.ts` is LF.
 */

const withheldGlobalSet: ReadonlySet<string> = new Set(
  SANDBOX_WITHHELD_GLOBALS,
);

/** Splits text into lines that each keep their own line ending. */
function splitKeepingLineEndings(source: string): string[] {
  return source.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function countUnbracketed(line: string, bracket: string): number {
  let count = 0;
  for (const character of line) {
    if (character === bracket) count += 1;
  }
  return count;
}

/**
 * Returns the index one past the declaration that starts at `start`, or
 * undefined when the braces never balance.
 */
function declarationEnd(lines: string[], start: number): number | undefined {
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    depth += countUnbracketed(line, "{") - countUnbracketed(line, "}");
    if (depth === 0 && line.trimEnd().endsWith(";")) return index + 1;
    if (depth < 0) return undefined;
  }
  return undefined;
}

export interface StripResult {
  text: string;
  /** Names whose declaration was found and removed. */
  removed: string[];
}

export function stripWithheldGlobals(
  source: string,
  names: ReadonlySet<string> = withheldGlobalSet,
): StripResult {
  const lines = splitKeepingLineEndings(source);
  const drop = new Set<number>();
  const removed: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^declare (?:var|function) ([A-Za-z_$][\w$]*)\s*[:=(<]/.exec(
      lines[index],
    );
    if (!match || !names.has(match[1])) continue;

    const end = declarationEnd(lines, index);
    if (end === undefined) {
      throw new Error(
        `Unbalanced declaration for "${match[1]}" at line ${index + 1}`,
      );
    }
    for (let line = index; line < end; line += 1) drop.add(line);
    // Take one trailing blank line with it, so removing a declaration does not
    // leave a double blank behind.
    if (end < lines.length && lines[end].trim() === "") drop.add(end);
    removed.push(match[1]);
    index = end - 1;
  }

  const text = lines.filter((_, index) => !drop.has(index)).join("");
  return { text, removed };
}

/**
 * Names still bound after a strip. `stripWithheldGlobals` handles the two
 * declaration forms it knows; a withheld name bound any other way — a
 * `declare namespace`, say — would otherwise be reported as stripped when
 * nothing was removed, leaving the type library declaring it and this script
 * claiming otherwise.
 */
function stillDeclared(
  text: string,
  names: ReadonlySet<string> = withheldGlobalSet,
): string[] {
  const matches = text.matchAll(
    /^declare (?:var|function|namespace|class|const|let|enum) ([A-Za-z_$][\w$]*)/gm,
  );
  return [...new Set([...matches].map((match) => match[1]))]
    .filter((name) => names.has(name));
}

/** The type libraries the pattern compiler serves that bind globals. */
const TYPE_LIB_FILES = ["es2023.d.ts", "dom.d.ts"] as const;

const STRIP_TASK = "deno task strip-withheld-globals";

function typeLibPath(file: string): string {
  return fromFileUrl(new URL(`../assets/types/${file}`, import.meta.url));
}

/**
 * Runs the command-line interface and returns the process exit code. With
 * `--check` it reports whether the checked-in libraries still declare a
 * withheld global; otherwise it rewrites them.
 */
export interface RunCliOptions {
  /** Type-library file names to process; defaults to the checked-in set. */
  files?: readonly string[];
  /** Reads a file's text; defaults to the filesystem. */
  readFile?: (path: string) => Promise<string>;
  /** Writes a file's text; defaults to the filesystem. */
  writeFile?: (path: string, text: string) => Promise<void>;
}

export async function runCli(
  args: string[],
  options: RunCliOptions = {},
): Promise<number> {
  const check = args.includes("--check");
  const files = options.files ?? TYPE_LIB_FILES;
  const readFile = options.readFile ?? Deno.readTextFile;
  const writeFile = options.writeFile ?? Deno.writeTextFile;
  let stale = false;

  for (const file of files) {
    const path = typeLibPath(file);
    const before = await readFile(path);
    const { text, removed } = stripWithheldGlobals(before);

    const unstrippable = stillDeclared(text);
    if (unstrippable.length > 0) {
      stale = true;
      console.error(
        `${file} declares ${unstrippable.join(", ")} in a form this script ` +
          `cannot strip. Remove the declaration by hand, or teach ` +
          `stripWithheldGlobals the form.`,
      );
    }

    if (check) {
      if (removed.length > 0) {
        stale = true;
        console.error(
          `${file} still declares ${removed.join(", ")}. ` +
            `Run \`${STRIP_TASK}\` to remove them.`,
        );
      }
      continue;
    }

    if (text !== before) await writeFile(path, text);
    console.log(
      removed.length > 0
        ? `${file}: removed ${removed.join(", ")}`
        : `${file}: already up to date`,
    );
  }

  if (check && !stale) {
    console.log("Type libraries declare no withheld globals.");
  }
  return stale ? 1 : 0;
}

/**
 * Entry point: runs the CLI and exits with its status, but only when this
 * module is the program's entry point. `isMain` and `exit` are injectable so
 * the entry behavior can be exercised without terminating the test runner.
 */
export async function cliMain(
  args: string[] = Deno.args,
  isMain: boolean = import.meta.main,
  exit: (code: number) => void = Deno.exit,
): Promise<void> {
  if (!isMain) return;
  exit(await runCli(args));
}

await cliMain();
