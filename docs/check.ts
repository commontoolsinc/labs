#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
//
// Type-checks the TypeScript/TSX code blocks embedded in the Markdown docs.
//
// Most doc snippets are fragments: they show the body of a pattern, a piece of
// JSX, or a set of interface members, and they lean on identifiers that the
// surrounding (elided) code would provide. A bare `deno check --doc-only` checks
// each block as a standalone module, so every fragment fails. Instead, each
// block opts into one of four "contexts" by starting with a short comment, and
// this checker splices the block into the matching scaffold before checking it:
//
//   // Shown at module scope.                  -> top level of a module
//   // Shown inside a pattern body.            -> inside `function () { ... }`
//   // Shown as JSX element children.          -> inside `<>...</>`
//   // Shown as interface or class members.    -> inside `interface { ... }` / `class { ... }`
//   // Shown for illustration only.            -> not type-checked (pseudocode)
//
// A block with no such comment is checked as-is (a standalone module), matching
// the previous behaviour. The scaffold supplies the framework surface (a real
// `commonfabric` import) plus ambient declarations for the example identifiers
// listed in `check.vocabulary.json`.
//
// Usage: deno run -A docs/check.ts [subfolder]

import { walk } from "@std/fs/walk";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";

const DOCS_DIR = dirname(fromFileUrl(import.meta.url));

export type Context =
  | "module"
  | "pattern"
  | "jsx"
  | "member"
  | "alternatives"
  | "skip"
  | "standalone";

const MARKERS: Array<[RegExp, Context]> = [
  [/^\/\/\s*Shown at module scope\.?\s*$/i, "module"],
  [/^\/\/\s*Shown inside a pattern body\.?\s*$/i, "pattern"],
  [/^\/\/\s*Shown as JSX element children\.?\s*$/i, "jsx"],
  [/^\/\/\s*Shown as interface or class members\.?\s*$/i, "member"],
  [/^\/\/\s*Shown as alternative snippets\.?\s*$/i, "alternatives"],
  [/^\/\/\s*Shown for illustration only\.?\s*$/i, "skip"],
];

// A "wrong then right" comment separates alternative snippets that share a name.
const ALT_SEPARATOR = new RegExp(
  "^\\s*//.*(WRONG|CORRECT|BAD\\b|GOOD\\b|❌|✅|✓|✗|🚫|⚠|Avoid|Instead|" +
    "Before:|After:|Don't|Do:|anti-?pattern)",
  "i",
);
function altSegments(body: string): string[] {
  const lines = body.split("\n");
  const segs: string[][] = [[]];
  for (let i = 0; i < lines.length; i++) {
    const cur = segs[segs.length - 1];
    const sep = ALT_SEPARATOR.test(lines[i]) ||
      (lines[i].trim() === "" && i + 1 < lines.length &&
        ALT_SEPARATOR.test(lines[i + 1]));
    if (sep && cur.some((l) => l.trim())) segs.push([]);
    segs[segs.length - 1].push(lines[i]);
  }
  return segs.map((s) => s.join("\n")).filter((s) => s.trim());
}

const CHECKED_LANGS = new Set([
  "ts", "tsx", "typescript", "js", "jsx", "javascript",
]);

// A block contains JSX when it has a closing tag, an element with attributes, or
// a self-closing element. Generics and `<T>` casts do not match.
export function hasJsx(s: string): boolean {
  return /<\/[A-Za-z]/.test(s) ||
    /<[A-Za-z][\w.-]*\s+[\w$:-]+\s*=/.test(s) ||
    /<[A-Za-z][\w.-]*\s*\/>/.test(s);
}

// The temp-file extension must follow the fence language: plain `ts`/`typescript`
// blocks may use angle-bracket type assertions and generics that parse
// differently under TSX, so they default to a `.ts` extension. A block that
// actually contains JSX (and the JSX context, which wraps it in a fragment)
// needs `.tsx`.
export function extFor(lang: string, ctx: Context, body = ""): string {
  if (ctx === "jsx") return "tsx";
  if (lang === "ts" || lang === "typescript") {
    return hasJsx(body) ? "tsx" : "ts";
  }
  return "tsx";
}

// --- vocabulary ------------------------------------------------------------

interface Vocabulary {
  frameworkValues: string[];
  frameworkTypes: string[];
  collections: string[];
  others: string[];
}
const VOCAB: Vocabulary = JSON.parse(
  Deno.readTextFileSync(join(DOCS_DIR, "check.vocabulary.json")),
);
const CF_VALUES = VOCAB.frameworkValues;
const CF_TYPES = VOCAB.frameworkTypes;
const CF_ALL = new Set([...CF_VALUES, ...CF_TYPES]);
const AMBIENT_NAMES = [...VOCAB.collections, ...VOCAB.others];

// A name is treated as a cell/array (rather than a plain `any`) only within a
// block that actually maps/filters it. Deciding this per block — instead of
// globally — avoids the conflict of a name that is an array in one snippet and a
// scalar in another.
const ARRAY_METHODS =
  "map|filter|forEach|reduce|find|findIndex|some|every|flatMap|sort|toSpliced|slice|concat|flat";
function arrayReceivers(body: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*(?:\\.get\\(\\)\\s*)?\\.\\s*(?:${ARRAY_METHODS})\\s*\\(`,
    "g",
  );
  for (const m of body.matchAll(re)) out.add(m[1]);
  return out;
}

// --- block extraction ------------------------------------------------------

export interface Block {
  file: string; // absolute path
  docDir: string;
  fenceLine: number; // 1-based line of the opening fence
  lang: string;
  body: string;
}

export function extractBlocks(file: string, text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const out: Block[] = [];
  // The language token, then any further info-string (e.g. `title=...`, `{1,3}`).
  const fence = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)[^\n]*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = fence.exec(lines[i]);
    if (!m) continue;
    const ticks = m[2];
    const lang = m[3].toLowerCase();
    const close = new RegExp(`^\\s*${ticks[0]}{${ticks.length},}\\s*$`);
    let j = i + 1;
    const content: string[] = [];
    while (j < lines.length && !close.test(lines[j])) content.push(lines[j++]);
    if (CHECKED_LANGS.has(lang)) {
      out.push({
        file,
        docDir: dirname(file),
        fenceLine: i + 1,
        lang,
        body: content.join("\n"),
      });
    }
    i = j;
  }
  return out;
}

// --- context detection -----------------------------------------------------

export function detectContext(body: string): { ctx: Context; body: string } {
  const lines = body.split("\n");
  let k = 0;
  while (k < lines.length && lines[k].trim() === "") k++;
  if (k < lines.length) {
    for (const [re, ctx] of MARKERS) {
      if (re.test(lines[k].trim())) {
        lines.splice(k, 1); // drop the routing directive from the checked source
        return { ctx, body: lines.join("\n") };
      }
    }
  }
  return { ctx: "standalone", body };
}

// --- source transform ------------------------------------------------------

const DEFINED =
  /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const DESTRUCTURE =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([{[][^=;]*?[}\]])\s*=/gm;
// The clause may span lines (`import {\n  A,\n} from "..."`), but must not cross
// a `;` or the `from` keyword, so it can't swallow an adjacent import statement.
const CLAUSE = String.raw`((?:(?!\bfrom\b)[^;])+?)`;
const REL_IMPORT = new RegExp(
  String.raw`^[ \t]*import\s+(?:type\s+)?${CLAUSE}\s+from\s+["'](\.\.?\/[^"']+)["'];?[ \t]*$`,
  "gm",
);
const IMPORT_CLAUSE = new RegExp(
  String.raw`^[ \t]*import\s+(?:type\s+)?${CLAUSE}\s+from\s+["'][^"']+["'];?[ \t]*$`,
  "gm",
);

function boundNames(clause: string): Set<string> {
  const names = new Set<string>();
  clause = clause.trim();
  const def = /^([A-Za-z_$][\w$]*)/.exec(clause);
  if (def && clause[0] !== "{" && clause[0] !== "*") names.add(def[1]);
  const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  if (ns) names.add(ns[1]);
  const braced = /\{([^}]*)\}/.exec(clause);
  if (braced) {
    for (let part of braced[1].split(",")) {
      part = part.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const nm = part.split(/\s+as\s+/).pop()!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
    }
  }
  return names;
}

// Rewrite a relative import to an absolute file: URL (so siblings resolve like
// the doc directory). Strip it and ambient-declare its names if absent.
function resolveImports(
  src: string,
  docDir: string,
): { src: string; ambient: Set<string> } {
  const ambient = new Set<string>();
  const candidates = (spec: string) => [
    spec,
    `${spec}.ts`,
    `${spec}.tsx`,
    `${spec}/mod.ts`,
    `${spec}/index.ts`,
  ];
  const out = src.replace(REL_IMPORT, (full, clause, spec) => {
    for (const cand of candidates(spec)) {
      const target = join(docDir, cand);
      try {
        const st = Deno.statSync(target);
        if (st.isFile) {
          const url = toFileUrl(target).href;
          return full.replace(`"${spec}"`, `"${url}"`).replace(
            `'${spec}'`,
            `"${url}"`,
          );
        }
      } catch {
        // try next candidate
      }
    }
    for (const n of boundNames(clause)) ambient.add(n);
    return "";
  });
  return { src: out, ambient };
}

// Cell-like example identifiers stand in for reactive cells: they are indexed
// and mapped like arrays, called and constructed like the cell factories, and
// expose cell methods (`get`, `set`, `sink`, `key`, ...). Extending Array keeps
// `.map((x) => ...)` callbacks contextually typed (so they do not trip
// `noImplicitAny`); the callback-taking methods type their callbacks for the
// same reason. The string index signature absorbs any other member access.
const DOC_CELL =
  "interface __DocCell<T = any> extends Array<T> {\n" +
  "  <A = any, B = any, C = any, D = any, E = any>(...args: any[]): any;\n" +
  "  new <A = any, B = any, C = any, D = any, E = any>(...args: any[]): any;\n" +
  "  get(): any[]; set(v: any): void; update(fn: (v: any) => any): void;\n" +
  "  remove(x: any): void; key(k: any): any; send(x: any): void;\n" +
  "  sink(cb: (v: any) => any): any;\n" +
  "  [k: string]: any;\n" +
  "}\n";

function ambientFor(names: Iterable<string>, arrays: Set<string>): string {
  const out: string[] = [];
  for (const n of names) {
    out.push(
      arrays.has(n)
        ? `declare const ${n}: __DocCell;`
        : `declare const ${n}: any;`,
    );
    out.push(`type ${n}<A = any, B = any, C = any, D = any, E = any> = any;`);
  }
  return out.join("\n");
}

function destructuredNames(binding: string): string[] {
  const inner = binding.replace(/^[{[]|[}\]]$/g, "");
  const names: string[] = [];
  for (let part of inner.split(",")) {
    part = part.trim().replace(/^\.\.\./, "").split("=")[0].trim();
    if (!part) continue;
    const colon = part.split(":");
    const target = (colon.length > 1 ? colon[1] : colon[0]).trim();
    const m = /^[A-Za-z_$][\w$]*/.exec(target);
    if (m) names.push(m[0]);
  }
  return names;
}

function preamble(
  body: string,
  extraAmbient: Set<string>,
  extraNames: string[] = [],
): string {
  // Names the block defines or imports itself must not be re-declared.
  const defined = new Set<string>();
  for (const m of body.matchAll(DEFINED)) defined.add(m[1]);
  for (const m of body.matchAll(DESTRUCTURE)) {
    for (const n of destructuredNames(m[1])) defined.add(n);
  }
  for (const m of body.matchAll(IMPORT_CLAUSE)) {
    for (const n of boundNames(m[1])) defined.add(n);
  }

  // Real `commonfabric` import for the framework surface (its callback
  // signatures give the snippet's arrows contextual types), minus whatever the
  // block defines or imports. A name brought in by a (stripped) relative import
  // is the block's own local value, so it overrides the framework name: it is
  // declared ambient rather than imported, even when it shares a framework name.
  const importValues = CF_VALUES.filter(
    (n) => !defined.has(n) && !extraAmbient.has(n),
  );
  const importTypes = CF_TYPES.filter(
    (n) => !defined.has(n) && !extraAmbient.has(n),
  );
  const cfImport = [
    importValues.length
      ? `import { ${importValues.join(", ")} } from "commonfabric";`
      : "",
    importTypes.length
      ? `import type { ${importTypes.join(", ")} } from "commonfabric";`
      : "",
  ].filter(Boolean).join("\n");

  const needed = new Set([
    ...AMBIENT_NAMES.filter((n) => !CF_ALL.has(n) && !extraAmbient.has(n)),
    ...extraAmbient,
    ...extraNames,
  ]);
  for (const n of defined) needed.delete(n);

  return `${cfImport}\n${DOC_CELL}${
    ambientFor(needed, arrayReceivers(body))
  }\n`;
}

// Decorators a class-body snippet may use; declared as part of the (deduplicated)
// ambient so they never collide with an example identifier of the same name.
const DECORATOR_NAMES = ["property", "state", "customElement", "query"];

function looksLikeClassBody(body: string): boolean {
  return /@[A-Za-z]/.test(body) || // decorators
    /^\s*[A-Za-z_$][\w$]*\s*=/.test(body) || // field initialisers
    /\)\s*(?::[^;{]+)?\{/.test(body); // method bodies
}

export function render(ctx: Context, rawBody: string, docDir: string): string {
  const { src, ambient } = resolveImports(rawBody, docDir);
  if (ctx === "standalone") return src + "\n";
  const pre = preamble(src, ambient);
  switch (ctx) {
    case "module":
      return `${pre}\n${src}\n`;
    case "pattern":
      return `${pre}\nexport async function __snippet(): Promise<any> {\n${src}\n}\n`;
    case "alternatives": {
      // Each alternative goes in its own block scope so the same name can be
      // declared in the "wrong" and "right" versions without colliding.
      const body = altSegments(src).map((s) => `{\n${s}\n}`).join("\n");
      return `${pre}\nexport async function __snippet(): Promise<any> {\n${body}\n}\n`;
    }
    case "jsx":
      return `${pre}\nexport const __snippet: any = (<>\n${src}\n</>);\n`;
    case "member":
      return looksLikeClassBody(src)
        ? `${preamble(src, ambient, DECORATOR_NAMES)}\nclass __Snippet {\n${src}\n}\n`
        : `${pre}\ninterface __Snippet {\n${src}\n}\n`;
    default:
      return src + "\n";
  }
}

// --- runner ----------------------------------------------------------------

async function denoCheck(paths: string[]): Promise<number> {
  const { code } = await new Deno.Command("deno", {
    args: ["check", "--no-lock", ...paths],
    cwd: dirname(DOCS_DIR),
    stdout: "null",
    stderr: "null",
  }).output();
  return code;
}

async function checkFile(path: string): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("deno", {
    args: ["check", "--no-lock", path],
    cwd: dirname(DOCS_DIR),
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code === 0) return "";
  return new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
}

async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface Job {
  block: Block;
  ctx: Context;
  tmp: string;
}

async function run(tmpDir: string): Promise<number> {
  const sub = Deno.args[0];
  const root = sub ? join(DOCS_DIR, sub) : DOCS_DIR;

  const blocks: Block[] = [];
  for await (const entry of walk(root, { exts: [".md"], includeDirs: false })) {
    if (entry.path.includes("/.doccheck")) continue;
    blocks.push(...extractBlocks(entry.path, Deno.readTextFileSync(entry.path)));
  }

  const jobs: Job[] = [];
  blocks.forEach((block, idx) => {
    const { ctx, body } = detectContext(block.body);
    if (ctx === "skip") return;
    const tmp = join(tmpDir, `b${idx}.${extFor(block.lang, ctx, body)}`);
    Deno.writeTextFileSync(tmp, render(ctx, body, block.docDir));
    jobs.push({ block, ctx, tmp });
  });

  // Fast path: type-check the temp files in a few batched invocations (the
  // framework graph is then resolved once and shared). Only if a batch reports
  // an error do we re-check its files individually, to attribute it precisely.
  const CHUNK = 120;
  const chunks: Job[][] = [];
  for (let i = 0; i < jobs.length; i += CHUNK) {
    chunks.push(jobs.slice(i, i + CHUNK));
  }
  const codes = await pool(chunks, 4, (c) => denoCheck(c.map((j) => j.tmp)));

  let failures = 0;
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  if (codes.some((c) => c !== 0)) {
    const outputs = await pool(jobs, 8, (j) => checkFile(j.tmp));
    jobs.forEach((job, i) => {
      const out = outputs[i];
      if (!out) return;
      failures++;
      const clean = out.replace(ansi, "").split("\n")
        .filter((l) => /TS\d+|error:|SyntaxError|^\s+at /.test(l))
        .slice(0, 12).join("\n");
      console.error(
        `\n✗ ${job.block.file}:${job.block.fenceLine} (context: ${job.ctx})\n${clean}`,
      );
    });
    if (!failures) {
      console.error(
        "A batched check reported an error that did not reproduce per-file; " +
          "re-run to diagnose.",
      );
      return 1;
    }
  }

  const checked = jobs.length;
  if (failures) {
    console.error(`\n${failures} of ${checked} checked code block(s) failed.`);
    return 1;
  }
  console.log(`All ${checked} checked code block(s) passed.`);
  return 0;
}

async function main() {
  const tmpDir = await Deno.makeTempDir({ dir: DOCS_DIR, prefix: ".doccheck-" });
  let code = 1;
  try {
    code = await run(tmpDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
  if (code !== 0) Deno.exit(code);
}

if (import.meta.main) await main();
