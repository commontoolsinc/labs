// Decoding stored Fabric values into an inspectable form.
//
// Stored payloads (`revision.data`, `commit.original`, …) come in TWO at-rest
// formats, BOTH seen in real DBs:
//   - modern: a `data-model` codec-json envelope, carrying that codec's prefix
//     (decode via valueFromJson)
//   - legacy: plain JSON
// In both, links/refs/streams appear as plain-data sigils:
//   link   { "/": { "link@1": { id, space?, path?, scope?, schema? } } }
//   ref    { "/": "of:…" | "computed:…" | "fid1:…" }
//   stream { "$stream": true }
// `decodeStored()` routes on the presence of that prefix, whichever codec
// version it names; everything else here is pure JSON walking + recognition (no
// live runtime/Cell needed). In the encoded form embedded links are
// `/quote`-escaped literals, so a context-less decode is inert.

import { seemsLikeJsonEncodedFabricValue } from "@commonfabric/data-model/codec-json";
import { valueFromJson } from "@commonfabric/data-model/codecs";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { isPlainObject } from "@commonfabric/utils/types";

/** Decode a stored payload string, routing the `data-model` codec envelope. */
export function decodeStored(data: string): unknown {
  return seemsLikeJsonEncodedFabricValue(data)
    ? valueFromJson(data)
    : JSON.parse(data);
}

export interface DecodedLink {
  id?: string;
  space?: string;
  path?: readonly string[];
  scope?: string;
  hasSchema: boolean;
}

type Json = unknown;

/**
 * Whether `v` is a record this file may descend by property name.
 *
 * The question is about SHAPE, and a class instance is not one whatever its
 * contents: a `FabricSpecialObject` keeps its state in private fields, so
 * rebuilding one from its enumerable properties yields `{}`. Descending is
 * reserved for values whose properties are the whole of what they say.
 */
function isNameWalkable(v: Json): v is Record<string, Json> {
  return isPlainObject(v);
}

function setOwn(target: Record<string, Json>, key: string, value: Json): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function payloadToLink(payload: Record<string, Json>): DecodedLink {
  return {
    id: typeof payload.id === "string" ? payload.id : undefined,
    space: typeof payload.space === "string" ? payload.space : undefined,
    path: Array.isArray(payload.path)
      ? (payload.path as readonly string[])
      : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    hasSchema: payload.schema !== undefined,
  };
}

/** A sigil link: `{ "/": { "link@N": {...} } }` (legacy at-rest form). */
export function parseSigilLink(v: Json): DecodedLink | null {
  if (!isNameWalkable(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "/") return null;
  const inner = v["/"];
  if (!isNameWalkable(inner)) return null;
  const linkKey = Object.keys(inner).find((k) => k.startsWith("link@"));
  if (!linkKey) return null;
  const payload = inner[linkKey];
  if (!isNameWalkable(payload)) return null;
  return payloadToLink(payload);
}

/**
 * A link in EITHER at-rest form: the legacy `{ "/": { "link@N": … } }` sigil, or
 * a modern `FabricLink` instance (which `valueFromJson` can restore from a
 * codec envelope). Detected by class — `cell-rep`'s `isLinkRef` is gated on a
 * global modern-mode flag the inspector doesn't set, so we check `FabricLink`
 * directly and read its `.payload`. Without this, a modern link is an opaque
 * instance with no enumerable keys and vanishes from links/lineage/graph.
 */
export function decodedLinkOf(v: Json): DecodedLink | null {
  const sigil = parseSigilLink(v);
  if (sigil) return sigil;
  if (v instanceof FabricLink) {
    const payload = v.payload as Record<string, Json>;
    return payloadToLink(payload);
  }
  return null;
}

/** An entity reference: `{ "/": "of:…" | "computed:…" | "fid1:…" }`. */
export function parseEntityRef(v: Json): string | null {
  if (!isNameWalkable(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "/") return null;
  return typeof v["/"] === "string" ? (v["/"] as string) : null;
}

export function isStream(v: Json): boolean {
  return isNameWalkable(v) && v["$stream"] === true;
}

function shortDid(did?: string): string | undefined {
  if (!did) return undefined;
  // did:key:z6Mk…wQ2n  ->  z6Mk…wQ2n
  const tail = did.startsWith("did:key:") ? did.slice("did:key:".length) : did;
  return tail.length > 12 ? `${tail.slice(0, 6)}…${tail.slice(-4)}` : tail;
}

function shortId(id?: string): string | undefined {
  if (!id) return undefined;
  // Strip `of:` for brevity; keep a `computed:` scheme visible — the hash
  // preimage is kind-free, so the scheme is the only thing distinguishing a
  // computed doc from a state sibling of the same cause.
  if (id.startsWith("computed:")) {
    const body = id.slice("computed:".length);
    return body.length > 14
      ? `computed:${body.slice(0, 8)}…${body.slice(-4)}`
      : id;
  }
  const body = id.replace(/^of:/, "");
  return body.length > 14 ? `${body.slice(0, 8)}…${body.slice(-4)}` : body;
}

const SAFE_SUMMARY_SEGMENT = /^[A-Za-z0-9_$@.:%+~-]+$/;
const UNSAFE_TERMINAL_UNICODE =
  /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

function escapeUnsafeTerminalUnicode(value: string): string {
  return value.replace(
    UNSAFE_TERMINAL_UNICODE,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Escape text for safe inclusion within one line of terminal output. */
export function escapeTerminalText(value: string): string {
  const quoted = escapeUnsafeTerminalUnicode(JSON.stringify(value));
  return quoted.slice(1, -1);
}

function quoteTerminalText(value: string): string {
  return escapeUnsafeTerminalUnicode(JSON.stringify(value));
}

function summarizePath(path: readonly string[]): string {
  if (path.every((segment) => SAFE_SUMMARY_SEGMENT.test(segment))) {
    return `/${path.join("/")}`;
  }
  return escapeUnsafeTerminalUnicode(JSON.stringify(path));
}

function summarizeKey(key: string): string {
  return SAFE_SUMMARY_SEGMENT.test(key) ? key : quoteTerminalText(key);
}

/** One-line, human-readable summary of a link for tables. */
export function summarizeLink(link: DecodedLink): string {
  const id = escapeTerminalText(shortId(link.id) ?? "?");
  const path = link.path && link.path.length ? summarizePath(link.path) : "";
  const space = link.space
    ? ` @${escapeTerminalText(shortDid(link.space) ?? "")}`
    : "";
  const schema = link.hasSchema ? " +schema" : "";
  return `🔗 ${id}${path}${space}${schema}`;
}

interface AnnotationVisit {
  kind: "visit";
  value: Json;
  depth: number;
  target: Record<string, Json>;
  key: string;
}

interface AnnotationLeave {
  kind: "leave";
  value: object;
}

type AnnotationFrame = AnnotationVisit | AnnotationLeave;

/**
 * Transform a stored value into an annotated, JSON-printable form. Links
 * become `{ $link: … }`, entity refs become `{ $ref: … }`, and streams become
 * `"$stream"`. `maxDepth` limits how many nested containers are retained.
 */
export function annotate(v: Json, maxDepth = 8): Json {
  const root: Record<string, Json> = {};
  const detectCycles = !Number.isFinite(maxDepth);
  const ancestors = new WeakSet<object>();
  const work: AnnotationFrame[] = [{
    kind: "visit",
    value: v,
    depth: maxDepth,
    target: root,
    key: "value",
  }];

  while (work.length > 0) {
    const frame = work.pop()!;
    if (frame.kind === "leave") {
      ancestors.delete(frame.value);
      continue;
    }

    const assign = (value: Json) => setOwn(frame.target, frame.key, value);
    if (frame.depth < 0) {
      assign("…");
      continue;
    }

    const link = decodedLinkOf(frame.value);
    if (link) {
      assign({
        $link: {
          id: link.id,
          ...(link.path && link.path.length ? { path: link.path } : {}),
          ...(link.space ? { space: link.space } : {}),
          ...(link.scope ? { scope: link.scope } : {}),
          ...(link.hasSchema ? { schema: true } : {}),
        },
      });
      continue;
    }
    if (isStream(frame.value)) {
      assign("$stream");
      continue;
    }
    const ref = parseEntityRef(frame.value);
    if (ref !== null) {
      assign({ $ref: ref });
      continue;
    }

    // Lower non-JSON-safe Fabric leaves to a stable, printable form so the
    // bundle and its JSON output retain every stored value.
    if (frame.value === undefined) {
      assign({ $undefined: true });
      continue;
    }
    if (typeof frame.value === "bigint") {
      assign({ $bigint: frame.value.toString() });
      continue;
    }
    if (typeof frame.value === "symbol") {
      assign(String(frame.value));
      continue;
    }
    if (typeof frame.value === "function") {
      assign("[function]");
      continue;
    }

    if (Array.isArray(frame.value)) {
      if (detectCycles && ancestors.has(frame.value)) {
        assign("…");
        continue;
      }
      if (detectCycles) {
        ancestors.add(frame.value);
        work.push({ kind: "leave", value: frame.value });
      }

      const keys = Object.keys(frame.value);
      if (
        keys.length === frame.value.length &&
        keys.every(isArrayIndexPropertyName)
      ) {
        const output = new Array<Json>(frame.value.length);
        assign(output);
        const target = output as unknown as Record<string, Json>;
        for (let index = frame.value.length - 1; index >= 0; index--) {
          work.push({
            kind: "visit",
            value: frame.value[index],
            depth: frame.depth - 1,
            target,
            key: String(index),
          });
        }
        continue;
      }

      const entries: Record<string, Json> = {};
      const properties: Record<string, Json> = {};
      const sparseArray: Record<string, Json> = {};
      setOwn(sparseArray, "length", frame.value.length);
      setOwn(sparseArray, "entries", entries);
      if (keys.some((key) => !isArrayIndexPropertyName(key))) {
        setOwn(sparseArray, "properties", properties);
      }
      assign({ $sparseArray: sparseArray });
      const source = frame.value as unknown as Record<string, Json>;
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        work.push({
          kind: "visit",
          value: source[key],
          depth: frame.depth - 1,
          target: isArrayIndexPropertyName(key) ? entries : properties,
          key,
        });
      }
      continue;
    }

    if (isNameWalkable(frame.value)) {
      if (detectCycles && ancestors.has(frame.value)) {
        assign("…");
        continue;
      }
      if (detectCycles) {
        ancestors.add(frame.value);
        work.push({ kind: "leave", value: frame.value });
      }

      const output: Record<string, Json> = {};
      assign(output);
      const entries = Object.entries(frame.value);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, value] = entries[index];
        work.push({
          kind: "visit",
          value,
          depth: frame.depth - 1,
          target: output,
          key,
        });
      }
      continue;
    }

    // A Fabric instance has no enumerable state to walk by property name.
    if (typeof frame.value === "object" && frame.value !== null) {
      assign({ $fabric: toCompactDebugString(frame.value) });
      continue;
    }
    assign(frame.value);
  }

  return root.value;
}

interface JsonValueFrame {
  kind: "value";
  value: Json;
  depth: number;
}

interface JsonTextFrame {
  kind: "text";
  value: string;
}

interface JsonLeaveFrame {
  kind: "leave";
  value: object;
}

type JsonFrame = JsonValueFrame | JsonTextFrame | JsonLeaveFrame;

const INSPECTOR_JSON_INDENTS = Array.from(
  { length: 33 },
  (_, depth) => "  ".repeat(depth),
);

function inspectorJsonIndent(depth: number): string {
  return INSPECTOR_JSON_INDENTS[Math.min(depth, 32)];
}

function omittedJsonObjectValue(value: Json): boolean {
  return value === undefined || typeof value === "function" ||
    typeof value === "symbol";
}

/**
 * Serialize annotated inspector data without recursive descent. Indentation
 * stops growing after 32 levels so deeply nested output stays linear in size.
 */
export function stringifyInspectorJson(value: Json): string {
  const output: string[] = [];
  const ancestors = new WeakSet<object>();
  const work: JsonFrame[] = [{
    kind: "value",
    value,
    depth: 0,
  }];

  while (work.length > 0) {
    const frame = work.pop()!;
    if (frame.kind === "text") {
      output.push(frame.value);
      continue;
    }
    if (frame.kind === "leave") {
      ancestors.delete(frame.value);
      continue;
    }

    if (frame.value === null) {
      output.push("null");
      continue;
    }
    switch (typeof frame.value) {
      case "string":
      case "boolean":
      case "number":
        output.push(JSON.stringify(frame.value));
        continue;
      case "undefined":
      case "function":
      case "symbol":
        output.push("null");
        continue;
      case "bigint":
        throw new TypeError("Inspector JSON contains an unannotated BigInt.");
    }

    if (ancestors.has(frame.value)) {
      throw new TypeError("Inspector JSON contains a circular structure.");
    }
    ancestors.add(frame.value);
    work.push({ kind: "leave", value: frame.value });

    if (Array.isArray(frame.value)) {
      output.push("[");
      if (frame.value.length === 0) {
        output.push("]");
        continue;
      }
      work.push({
        kind: "text",
        value: `\n${inspectorJsonIndent(frame.depth)}]`,
      });
      for (let index = frame.value.length - 1; index >= 0; index--) {
        work.push({
          kind: "value",
          value: frame.value[index],
          depth: frame.depth + 1,
        });
        work.push({
          kind: "text",
          value: `${index === 0 ? "\n" : ",\n"}${
            inspectorJsonIndent(frame.depth + 1)
          }`,
        });
      }
      continue;
    }

    const keys = Object.keys(frame.value).filter((key) =>
      !omittedJsonObjectValue((frame.value as Record<string, Json>)[key])
    );
    output.push("{");
    if (keys.length === 0) {
      output.push("}");
      continue;
    }
    work.push({
      kind: "text",
      value: `\n${inspectorJsonIndent(frame.depth)}}`,
    });
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      work.push({
        kind: "value",
        value: (frame.value as Record<string, Json>)[key],
        depth: frame.depth + 1,
      });
      work.push({
        kind: "text",
        value: `${index === 0 ? "\n" : ",\n"}${
          inspectorJsonIndent(frame.depth + 1)
        }${JSON.stringify(key)}: `,
      });
    }
  }

  return output.join("");
}

/** Compact one-line summary of any value, for table cells. */
export function summarize(v: Json): string {
  const link = decodedLinkOf(v);
  if (link) return summarizeLink(link);
  if (isStream(v)) return "⊙ stream";
  const ref = parseEntityRef(v);
  if (ref !== null) return `#${escapeTerminalText(shortId(ref) ?? ref)}`;
  if (v === null) return "null";
  if (typeof v === "bigint") return `${v}n`;
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isNameWalkable(v)) {
    return `{${Object.keys(v).map(summarizeKey).join(", ")}}`;
  }
  if (typeof v === "object") {
    return escapeTerminalText(toCompactDebugString(v));
  }
  if (typeof v === "string") {
    const preview = v.length > 40 ? `${v.slice(0, 37)}…` : v;
    return quoteTerminalText(preview);
  }
  return escapeTerminalText(String(v));
}

/** Collect every link reachable in a value (does not descend into links). */
export function collectLinks(v: Json, maxDepth = 12): DecodedLink[] {
  const out: DecodedLink[] = [];
  const walk = (x: Json, depth: number) => {
    if (depth < 0) return;
    const link = decodedLinkOf(x);
    if (link) {
      out.push(link);
      return;
    }
    if (isStream(x) || parseEntityRef(x) !== null) return;
    if (Array.isArray(x)) {
      for (const e of x) walk(e, depth - 1);
    } else if (isNameWalkable(x)) {
      for (const e of Object.values(x)) walk(e, depth - 1);
    }
  };
  walk(v, maxDepth);
  return out;
}

/** Count links reachable in a value (a cheap fan-out proxy). */
export function countLinks(v: Json, maxDepth = 8): number {
  if (maxDepth < 0) return 0;
  if (decodedLinkOf(v)) return 1;
  if (isStream(v) || parseEntityRef(v) !== null) return 0;
  if (Array.isArray(v)) {
    return v.reduce<number>((n, x) => n + countLinks(x, maxDepth - 1), 0);
  }
  if (isNameWalkable(v)) {
    return Object.values(v).reduce<number>(
      (n, x) => n + countLinks(x, maxDepth - 1),
      0,
    );
  }
  return 0;
}
