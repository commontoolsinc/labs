/**
 * Recover the caller tree from emitted timing measures.
 *
 * A logger records a span against its own key and nothing else, so
 * `tx/read` is `tx/read` whoever asked for it. What the measures add over the
 * statistics is an interval per span, and intervals nest: the span that was
 * open when another began is the one that called it. Rebuilding that
 * containment forest is what turns "this key ran 800,000 times" into "this key
 * ran 800,000 times, and here is who asked".
 *
 * Containment is inferred, not recorded. Spans that overlap without nesting —
 * which async work produces — are left without a parent rather than assigned a
 * plausible-looking one, because an invented parent is an invented caller.
 *
 * Used by `attribute-measures.ts`; import it for an analysis that script does
 * not cover.
 */

/** One emitted measure, as `performance.getEntriesByType("measure")` gives it. */
export interface MeasureEntry {
  name: string;
  startTime: number;
  duration: number;
}

/** A span placed in the forest. `parent` is an index, or -1 at a root. */
export interface Span {
  /** The logger key, with the uniquifying suffix removed. */
  key: string;

  start: number;
  end: number;
  parent: number;
}

/** Emitted entries carry this, so clearing can be selective. */
export const MEASURE_PREFIX = "cf:";

/** Separates a key from the detail naming one occurrence of it. */
export const MEASURE_DETAIL = "|";

/**
 * `cf:cell/get/user-data#4127` names the span `cell/get/user-data`, and
 * `cf:scheduler/run/action|topics/main#88` names `scheduler/run/action`.
 *
 * The detail is deliberately not part of the key: a key is a place in the code
 * and grouping by it is the whole point, so an occurrence's identity is
 * stripped here and read separately by anything that wants it.
 */

/**
 * The emitter percent-encodes both fields, so a key or detail containing a
 * separator survives the round trip instead of being read back as a split that
 * was never there.
 */
function decodeField(value: string): string {
  return value
    .replaceAll("%23", "#")
    .replaceAll("%7C", MEASURE_DETAIL)
    .replaceAll("%25", "%");
}

function splitName(name: string): { key: string; detail?: string } {
  const body = name.startsWith(MEASURE_PREFIX)
    ? name.slice(MEASURE_PREFIX.length)
    : name;
  const hash = body.lastIndexOf("#");
  const withoutSequence = hash === -1 ? body : body.slice(0, hash);
  const bar = withoutSequence.indexOf(MEASURE_DETAIL);
  return bar === -1 ? { key: decodeField(withoutSequence) } : {
    key: decodeField(withoutSequence.slice(0, bar)),
    detail: decodeField(withoutSequence.slice(bar + 1)),
  };
}

export function keyOf(name: string): string {
  return splitName(name).key;
}

/** Which occurrence this span was, where the emitter named one. */
export function detailOf(name: string): string | undefined {
  return splitName(name).detail;
}

/**
 * The test harness's own phases wrap everything a `cf test` run does, so they
 * would win every containment test and hide the runtime span that issued the
 * work. Treated as transparent by default when walking up.
 */
export const HARNESS_KEY = /^(runTestPattern|cf-test)(\/|$)/;

/**
 * Build the containment forest.
 *
 * Returns spans sorted by start, each carrying the index of the innermost span
 * that fully contains it. Sorting longest-first at an equal start is what puts
 * a parent before the child it opened alongside.
 */
export function buildForest(entries: readonly MeasureEntry[]): Span[] {
  const spans: Span[] = entries
    .map((entry) => ({
      key: keyOf(entry.name),
      start: entry.startTime,
      end: entry.startTime + entry.duration,
      parent: -1,
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const open: number[] = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    while (open.length && spans[open[open.length - 1]].end <= span.start) {
      open.pop();
    }
    // A strictly larger interval is a container. An identical one is two spans
    // that began and ended together, which says nothing about which called
    // which — so it is stepped over rather than claimed as a parent, and the
    // search continues beneath it: a real container further down the stack is
    // still the answer, and stopping at the twin would report a root instead.
    for (let k = open.length - 1; k >= 0; k--) {
      const candidate = spans[open[k]];
      if (candidate.start === span.start && candidate.end === span.end) {
        // A twin says nothing about which called which, but it does share
        // whatever contains it — so its answer is this span's answer, and
        // taking it keeps a long run of identical intervals from rescanning
        // the whole run for each one.
        span.parent = candidate.parent;
        break;
      }
      if (candidate.end >= span.end) {
        span.parent = open[k];
        break;
      }
      // Overlapping without containing: an outer span may still contain this.
    }
    open.push(i);
  }
  return spans;
}

/** Every ancestor key, innermost first. */
export function ancestors(
  spans: readonly Span[],
  index: number,
  options: { skip?: RegExp } = {},
): string[] {
  const skip = options.skip ?? HARNESS_KEY;
  const out: string[] = [];
  for (let p = spans[index].parent; p !== -1; p = spans[p].parent) {
    const key = spans[p].key;
    if (!skip.test(key)) out.push(key);
  }
  return out;
}

/**
 * The innermost ancestor that is not skipped, or `undefined` at a root.
 *
 * A root is a real answer rather than a gap in the data: it means the span ran
 * outside every instrumented region, which is a statement about where the
 * instrumentation stops.
 */
export function callerOf(
  spans: readonly Span[],
  index: number,
  options: { skip?: RegExp } = {},
): string | undefined {
  return ancestors(spans, index, options)[0];
}

/**
 * Collapse an immediate repeat, so a recursive stretch reads as one shape:
 * `["traverse", "traverse", "cell/get"]` becomes `["traverse x2", "cell/get"]`.
 */
export function collapseRepeats(chain: readonly string[]): string[] {
  const out: string[] = [];
  let last = "";
  let run = 0;
  for (const key of chain) {
    if (key === last) {
      run++;
      continue;
    }
    if (last) out.push(run > 1 ? `${last} x${run}` : last);
    last = key;
    run = 1;
  }
  if (last) out.push(run > 1 ? `${last} x${run}` : last);
  return out;
}

/** Read a measures file, or stdin when no path is given. */
export async function loadMeasures(path?: string): Promise<MeasureEntry[]> {
  let raw: string;
  if (path) {
    raw = await Deno.readTextFile(path);
  } else {
    const chunks: Uint8Array[] = [];
    for await (const chunk of Deno.stdin.readable) chunks.push(chunk);
    let length = 0;
    for (const chunk of chunks) length += chunk.length;
    const merged = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    raw = new TextDecoder().decode(merged);
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.measures ?? [];
}
