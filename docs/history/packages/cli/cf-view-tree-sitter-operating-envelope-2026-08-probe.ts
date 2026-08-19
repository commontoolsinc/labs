const moduleStarted = performance.now();
const STARTUP_SAMPLES = 40;
const WORK_SAMPLES = 50;
const TARGET_BYTES = 100_009;

// @owned-source-start
type TreeSitter = typeof import("npm:web-tree-sitter@0.26.12");
type Parser = InstanceType<TreeSitter["Parser"]>;
type Query = InstanceType<TreeSitter["Query"]>;
type Tree = NonNullable<ReturnType<Parser["parse"]>>;
type QueryCapture = ReturnType<Query["captures"]>[number];

interface InitializedParser {
  readonly parser: Parser;
  readonly query: Query;
}

interface HighlightSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

function captureKind(capture: QueryCapture): string {
  for (
    const category of [
      "comment",
      "string",
      "number",
      "keyword",
      "function",
      "type",
      "operator",
      "punctuation",
    ]
  ) {
    if (capture.name.includes(category)) return category;
  }
  return "identifier";
}

function normalizeCaptures(
  captures: QueryCapture[],
  rangeStart: number,
  rangeEnd: number,
): HighlightSpan[] {
  captures.sort((a, b) =>
    a.node.startIndex - b.node.startIndex || a.node.endIndex - b.node.endIndex
  );
  const spans: HighlightSpan[] = [];
  let claimed = rangeStart;
  for (const capture of captures) {
    const start = Math.max(claimed, capture.node.startIndex);
    const end = Math.min(rangeEnd, Math.max(start, capture.node.endIndex));
    if (start > claimed) {
      spans.push({ start: claimed, end: start, kind: "plain" });
    }
    if (end > start) {
      spans.push({ start, end, kind: captureKind(capture) });
      claimed = end;
    }
  }
  if (claimed < rangeEnd) {
    spans.push({ start: claimed, end: rangeEnd, kind: "plain" });
  }
  return spans;
}

function normalizedSpans(
  text: string,
  query: Query,
  tree: Tree,
): HighlightSpan[] {
  return normalizeCaptures(query.captures(tree.rootNode), 0, text.length);
}

function normalizedRangeSpans(
  query: Query,
  tree: Tree,
  startIndex: number,
  endIndex: number,
): HighlightSpan[] {
  return normalizeCaptures(
    query.captures(tree.rootNode, { startIndex, endIndex }),
    startIndex,
    endIndex,
  );
}

function highlightedLines(
  text: string,
  initialized: InitializedParser,
): string[][] {
  const tree = initialized.parser.parse(text);
  if (tree === null) throw new Error("Tree-sitter returned no tree");
  try {
    const lines: string[][] = [[]];
    for (const span of normalizedSpans(text, initialized.query, tree)) {
      const pieces = text.slice(span.start, span.end).split("\n");
      lines.at(-1)!.push(pieces[0]);
      for (const piece of pieces.slice(1)) lines.push([piece]);
    }
    return lines;
  } finally {
    tree.delete();
  }
}

async function initializePython(): Promise<InitializedParser> {
  const treeSitter = await import("npm:web-tree-sitter@0.26.12");
  await import("npm:tree-sitter-python@0.25.0/package.json", {
    with: { type: "json" },
  });
  const grammarUrl = import.meta.resolve(
    "npm:tree-sitter-python@0.25.0/tree-sitter-python.wasm",
  );
  const queryUrl = import.meta.resolve(
    "npm:tree-sitter-python@0.25.0/queries/highlights.scm",
  );
  const [grammarBytes, querySource] = await Promise.all([
    Deno.readFile(new URL(grammarUrl)),
    Deno.readTextFile(new URL(queryUrl)),
  ]);
  await treeSitter.Parser.init();
  const language = await treeSitter.Language.load(grammarBytes);
  const parser = new treeSitter.Parser();
  parser.setLanguage(language);
  return {
    parser,
    query: new treeSitter.Query(language, querySource),
  };
}

function disposeParser(initialized: InitializedParser): void {
  initialized.query.delete();
  initialized.parser.delete();
}
// @owned-source-end

function pythonSource(): string {
  const prefix = "# café appears before measured tokens\n";
  const unit = `@decorator
class RenderedItem[T]:
    async def render_item(self, value: T | None = None) -> str:
        label = f"value={value!r:>8}"
        return label
`;
  const encoder = new TextEncoder();
  let source = prefix;
  while (encoder.encode(source + unit).length + 3 <= TARGET_BYTES) {
    source += unit;
  }
  const remaining = TARGET_BYTES - encoder.encode(source).length;
  if (remaining > 0) source += `#${"x".repeat(remaining - 1)}`;
  if (encoder.encode(source).length !== TARGET_BYTES) {
    throw new Error("Python fixture has the wrong byte length");
  }
  return source;
}

function middleEdit(source: string) {
  const original = "render_item";
  const replacement = "render_unit";
  const startIndex = source.indexOf(original, Math.floor(source.length / 2));
  if (startIndex < 0) throw new Error("Middle edit target is absent");
  const endIndex = startIndex + original.length;
  return {
    source: source.slice(0, startIndex) + replacement + source.slice(endIndex),
    startIndex,
    endIndex,
  };
}

function pointAt(source: string, index: number) {
  const prefix = source.slice(0, index);
  const lines = prefix.split("\n");
  return { row: lines.length - 1, column: lines.at(-1)!.length };
}

function median(samples: readonly number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[Math.floor(middle)];
}

function p95(samples: readonly number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

if (Deno.args.includes("--cold")) {
  const initialized = await initializePython();
  highlightedLines("", initialized);
  const milliseconds = performance.now() - moduleStarted;
  disposeParser(initialized);
  console.log(JSON.stringify({ milliseconds }));
  Deno.exit();
}

const source = pythonSource();
const edit = middleEdit(source);
const initialized = await initializePython();
const reconstructed = highlightedLines(source, initialized)
  .map((line) => line.join(""))
  .join("\n");
if (reconstructed !== source) throw new Error("Highlighting changed source");

const highlightSamples: number[] = [];
highlightedLines(source, initialized);
for (let i = 0; i < WORK_SAMPLES; i++) {
  const started = performance.now();
  highlightedLines(source, initialized);
  highlightSamples.push(performance.now() - started);
}

const treeSitter = await import("npm:web-tree-sitter@0.26.12");
const incrementalSamples: number[] = [];
const startPosition = pointAt(source, edit.startIndex);
const endPosition = pointAt(source, edit.endIndex);
for (let i = 0; i < WORK_SAMPLES + 1; i++) {
  const oldTree = initialized.parser.parse(source);
  if (oldTree === null) throw new Error("Tree-sitter returned no old tree");
  const started = performance.now();
  oldTree.edit(
    new treeSitter.Edit({
      startIndex: edit.startIndex,
      oldEndIndex: edit.endIndex,
      newEndIndex: edit.endIndex,
      startPosition,
      oldEndPosition: endPosition,
      newEndPosition: endPosition,
    }),
  );
  const newTree = initialized.parser.parse(edit.source, oldTree);
  if (newTree === null) throw new Error("Tree-sitter returned no edited tree");
  const startIndex = edit.source.lastIndexOf("\n", edit.startIndex - 1) + 1;
  const newline = edit.source.indexOf("\n", edit.endIndex);
  const endIndex = newline < 0 ? edit.source.length : newline;
  normalizedRangeSpans(initialized.query, newTree, startIndex, endIndex);
  oldTree.delete();
  newTree.delete();
  const milliseconds = performance.now() - started;
  if (i > 0) incrementalSamples.push(milliseconds);
}

const startupSamples: number[] = [];
for (let i = 0; i < STARTUP_SAMPLES; i++) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--no-config",
      "--no-lock",
      import.meta.filename!,
      "--cold",
    ],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!output.success) throw new Error("Cold-start child failed");
  const result = JSON.parse(new TextDecoder().decode(output.stdout));
  startupSamples.push(result.milliseconds);
}

disposeParser(initialized);
console.log(JSON.stringify(
  {
    environment: {
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      typescript: Deno.version.typescript,
      os: Deno.build.os,
      arch: Deno.build.arch,
    },
    fixtureBytes: new TextEncoder().encode(source).length,
    startupMilliseconds: {
      samples: startupSamples,
      median: median(startupSamples),
      p95: p95(startupSamples),
    },
    fullHighlightMilliseconds: {
      samples: highlightSamples,
      median: median(highlightSamples),
      p95: p95(highlightSamples),
    },
    incrementalEditMilliseconds: {
      samples: incrementalSamples,
      median: median(incrementalSamples),
      p95: p95(incrementalSamples),
    },
  },
  null,
  2,
));
