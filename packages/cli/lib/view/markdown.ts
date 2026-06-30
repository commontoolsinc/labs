/**
 * A small Markdown highlighter, used when a diff (or a directly-opened file)
 * names a `.md`/`.markdown` file. The pager otherwise colours everything as
 * TypeScript, which turns prose into a soup of identifiers and operators and
 * paints inline-code backticks as runaway template literals. This colours the
 * things Markdown actually has — headings, fenced and inline code, block quotes,
 * list markers, rules and links — and leaves prose plain. Headings also become
 * the navigation tree, so `wasd`/Tab step through a document's sections.
 *
 * It is line-oriented (the only cross-line state is whether a fenced code block
 * is open), so re-highlighting is cheap enough to redo whole on every keystroke.
 */
import type {
  Document,
  Line,
  Span,
  StructureNode,
  TokenClass,
} from "./model.ts";
import { flattenStructure } from "./model.ts";
import type { Highlighter } from "./parse.ts";
import { cpLen } from "./ansi.ts";

/** Whether `fileName` names a Markdown file. */
export function isMarkdownPath(fileName: string | undefined): boolean {
  return fileName !== undefined &&
    /\.(md|markdown|mdown|mkd|mdx)$/i.test(fileName);
}

/** Colour Markdown text into rendered lines. */
export function highlightMarkdownLines(text: string): Line[] {
  const raw = text.split("\n");
  const out: Line[] = [];
  let fence: string | null = null; // the run (``` or ~~~) of an open code block
  for (const t of raw) {
    const opener = t.trimStart().match(/^(`{3,}|~{3,})/);
    if (fence !== null) {
      const closing = opener && t.trimStart().startsWith(fence);
      out.push(oneSpan(t, closing ? "punctuation" : "string"));
      if (closing) fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1];
      out.push(oneSpan(t, "punctuation"));
      continue;
    }
    out.push(renderLine(t));
  }
  return out;
}

/** A full Markdown {@link Document}: highlighted lines, headings as the
 * navigation tree, and no definitions. */
export function markdownDocument(text: string): Document {
  const raw = text.split("\n");
  const lineStarts = computeLineStarts(text);
  const lines = highlightMarkdownLines(text);
  const structure = headingTree(raw, lineStarts, text.length);
  const flatStructure = flattenStructure(structure);
  return { text, lines, structure, flatStructure, definitions: new Map() };
}

/** A whole-document Markdown highlighter (no incremental state needed). */
export function createMarkdownHighlighter(initial: string): Highlighter {
  let lines: Line[] = highlightMarkdownLines(initial);
  return {
    get lines() {
      return lines;
    },
    update(next: string): readonly Line[] {
      lines = highlightMarkdownLines(next);
      return lines;
    },
  };
}

function oneSpan(text: string, cls: TokenClass): Line {
  return text.length === 0
    ? { text: "", spans: [] }
    : { text, spans: [{ col: 0, text, cls }] };
}

/** Colour one non-fenced line by classifying each code point, then run-length
 * encoding the classes into spans. */
function renderLine(t: string): Line {
  if (t.length === 0) return { text: "", spans: [] };
  if (/^#{1,6}(\s|$)/.test(t)) return oneSpan(t, "sectionHeader");
  if (/^\s*>/.test(t)) return oneSpan(t, "comment");
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(t)) return oneSpan(t, "punctuation");

  const cps = [...t];
  const cls: TokenClass[] = new Array(cps.length).fill("plain");
  let start = 0;
  // A list marker (`- `, `* `, `1. `) past any indentation.
  const list = t.match(/^(\s*)([-*+]|\d{1,9}[.)])(\s)/);
  if (list) {
    const at = [...list[1]].length;
    for (let k = at; k < at + [...list[2]].length; k++) cls[k] = "punctuation";
    start = [...list[0]].length;
  }
  markInline(cps, start, cls);

  const spans: Span[] = [];
  for (let s = 0; s < cps.length;) {
    let e = s + 1;
    while (e < cps.length && cls[e] === cls[s]) e++;
    spans.push({ col: s, text: cps.slice(s, e).join(""), cls: cls[s] });
    s = e;
  }
  return { text: t, spans };
}

/** Mark inline code spans and links over `cls`, working in code points. */
function markInline(cps: string[], from: number, cls: TokenClass[]): void {
  let i = from;
  while (i < cps.length) {
    if (cps[i] === "`") {
      let n = 0;
      while (i + n < cps.length && cps[i + n] === "`") n++;
      let j = i + n;
      let close = -1;
      while (j < cps.length) {
        if (cps[j] === "`") {
          let m = 0;
          while (j + m < cps.length && cps[j + m] === "`") m++;
          if (m === n) {
            close = j + m;
            break;
          }
          j += m;
        } else j++;
      }
      if (close >= 0) {
        for (let k = i; k < close; k++) cls[k] = "string";
        i = close;
        continue;
      }
      i += n;
      continue;
    }
    // A `[text](url)` link: bracket/paren punctuation, the URL a string.
    if (cps[i] === "[") {
      const rb = cps.indexOf("]", i + 1);
      if (rb > i && cps[rb + 1] === "(") {
        const rp = cps.indexOf(")", rb + 2);
        if (rp > rb) {
          cls[i] =
            cls[rb] =
            cls[rb + 1] =
            cls[rp] =
              "punctuation";
          for (let k = rb + 2; k < rp; k++) cls[k] = "string";
          i = rp + 1;
          continue;
        }
      }
    }
    i++;
  }
}

/** Headings as a nested navigation tree: each heading owns the lines down to the
 * next heading of the same or a higher level. */
function headingTree(
  raw: string[],
  lineStarts: number[],
  textLen: number,
): StructureNode[] {
  const heads: { level: number; title: string; line: number }[] = [];
  let fence: string | null = null; // the run (``` or ~~~) of an open code block
  for (let i = 0; i < raw.length; i++) {
    const opener = raw[i].trimStart().match(/^(`{3,}|~{3,})/);
    if (fence !== null) {
      if (opener && raw[i].trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1];
      continue;
    }
    const m = raw[i].match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (m) heads.push({ level: m[1].length, title: m[2], line: i });
  }
  const lineEnd = (line: number) =>
    line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : textLen;
  const build = (from: number, level: number, depth: number): {
    nodes: StructureNode[];
    next: number;
  } => {
    const nodes: StructureNode[] = [];
    let k = from;
    while (k < heads.length && heads[k].level >= level) {
      if (heads[k].level > level) {
        // A deeper heading with no parent at this level: attach at this depth.
        const sub = build(k, heads[k].level, depth);
        nodes.push(...sub.nodes);
        k = sub.next;
        continue;
      }
      const h = heads[k];
      const sub = build(k + 1, h.level + 1, depth + 1);
      // The section runs to just before the next heading of the same or a
      // higher level (`sub.next`), so it encloses its sub-headings.
      const endLine = sub.next < heads.length
        ? heads[sub.next].line - 1
        : raw.length - 1;
      nodes.push({
        kind: "section",
        label: `${"#".repeat(h.level)} ${h.title}`,
        name: h.title,
        startLine: h.line,
        endLine: Math.max(h.line, endLine),
        startCol: 0,
        endCol: cpLen(raw[Math.max(h.line, endLine)] ?? ""),
        startOffset: lineStarts[h.line],
        endOffset: lineEnd(Math.max(h.line, endLine)),
        depth,
        children: sub.nodes,
      });
      k = sub.next;
    }
    return { nodes, next: k };
  };
  return build(0, 1, 0).nodes;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}
