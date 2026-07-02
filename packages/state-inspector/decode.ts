// Decoding stored Fabric values into an inspectable form.
//
// Stored payloads (`revision.data`, `commit.original`, …) come in TWO at-rest
// formats, BOTH seen in real DBs:
//   - modern: an `fvj1:`-prefixed codec-json envelope (decode via valueFromJson)
//   - legacy: plain JSON
// In both, links/refs/streams appear as plain-data sigils:
//   link   { "/": { "link@1": { id, space?, path?, scope?, schema? } } }
//   ref    { "/": "of:…" | "fid1:…" }
//   stream { "$stream": true }
// `decodeStored()` routes by the `fvj1:` tag; everything else here is pure JSON
// walking + recognition (no live runtime/Cell needed). In the fvj1 form embedded
// links are `/quote`-escaped literals, so a context-less decode is inert.

import { valueFromJson } from "@commonfabric/data-model/codec-json";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";

/** Decode a stored payload string, routing the `fvj1:` codec envelope. */
export function decodeStored(data: string): unknown {
  return data.startsWith("fvj1:") ? valueFromJson(data) : JSON.parse(data);
}

export interface DecodedLink {
  id?: string;
  space?: string;
  path?: readonly string[];
  scope?: string;
  hasSchema: boolean;
}

type Json = unknown;

function isPlainObject(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  if (!isPlainObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "/") return null;
  const inner = v["/"];
  if (!isPlainObject(inner)) return null;
  const linkKey = Object.keys(inner).find((k) => k.startsWith("link@"));
  if (!linkKey) return null;
  const payload = inner[linkKey];
  if (!isPlainObject(payload)) return null;
  return payloadToLink(payload);
}

/**
 * A link in EITHER at-rest form: the legacy `{ "/": { "link@N": … } }` sigil, or
 * a modern `FabricLink` instance (which `valueFromJson` can restore from an
 * `fvj1` envelope). Detected by class — `cell-rep`'s `isLinkRef` is gated on a
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

/** An entity reference: `{ "/": "of:…" | "fid1:…" }`. */
export function parseEntityRef(v: Json): string | null {
  if (!isPlainObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "/") return null;
  return typeof v["/"] === "string" ? (v["/"] as string) : null;
}

export function isStream(v: Json): boolean {
  return isPlainObject(v) && v["$stream"] === true;
}

function shortDid(did?: string): string | undefined {
  if (!did) return undefined;
  // did:key:z6Mk…wQ2n  ->  z6Mk…wQ2n
  const tail = did.startsWith("did:key:") ? did.slice("did:key:".length) : did;
  return tail.length > 12 ? `${tail.slice(0, 6)}…${tail.slice(-4)}` : tail;
}

function shortId(id?: string): string | undefined {
  if (!id) return undefined;
  const body = id.startsWith("of:") ? id.slice(3) : id;
  return body.length > 14 ? `${body.slice(0, 8)}…${body.slice(-4)}` : body;
}

/** One-line, human-readable summary of a link for tables. */
export function summarizeLink(link: DecodedLink): string {
  const id = shortId(link.id) ?? "?";
  const path = link.path && link.path.length ? `/${link.path.join("/")}` : "";
  const space = link.space ? ` @${shortDid(link.space)}` : "";
  const schema = link.hasSchema ? " +schema" : "";
  return `🔗 ${id}${path}${space}${schema}`;
}

/**
 * Recursively transform a stored value into an annotated, JSON-printable form:
 * links become `{ $link: … }`, entity refs `{ $ref: … }`, streams `"$stream"`.
 * `maxDepth` guards against deep/cyclic-looking structures.
 */
export function annotate(v: Json, maxDepth = 8): Json {
  if (maxDepth < 0) return "…";

  const link = decodedLinkOf(v);
  if (link) {
    return {
      $link: {
        id: link.id,
        ...(link.path && link.path.length ? { path: link.path } : {}),
        ...(link.space ? { space: link.space } : {}),
        ...(link.scope ? { scope: link.scope } : {}),
        ...(link.hasSchema ? { schema: true } : {}),
      },
    };
  }
  if (isStream(v)) return "$stream";
  const ref = parseEntityRef(v);
  if (ref !== null) return { $ref: ref };

  // Lower non-JSON-safe Fabric leaves to a stable, printable form so the bundle
  // (and every JSON.stringify export path that consumes it — HTML, CLI --json)
  // can't throw on a BigInt, render a Fabric instance as an opaque `{}`, or
  // SILENTLY DROP a stored `undefined` (which JSON.stringify omits — losing the
  // present-undefined vs absent-key distinction the data model preserves).
  if (v === undefined) return { $undefined: true };
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (typeof v === "symbol") return String(v);
  if (typeof v === "function") return "[function]";

  if (Array.isArray(v)) return v.map((x) => annotate(x, maxDepth - 1));
  if (isPlainObject(v)) {
    const out: Record<string, Json> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = annotate(val, maxDepth - 1);
    }
    return out;
  }
  // A non-plain object (a Fabric instance — bytes/regexp/epoch/hash/…) has no
  // enumerable own keys; render its canonical debug string instead of `{}`.
  if (typeof v === "object" && v !== null) {
    return { $fabric: toCompactDebugString(v) };
  }
  return v;
}

/** Compact one-line summary of any value, for table cells. */
export function summarize(v: Json): string {
  const link = decodedLinkOf(v);
  if (link) return summarizeLink(link);
  if (isStream(v)) return "⊙ stream";
  const ref = parseEntityRef(v);
  if (ref !== null) return `#${shortId(ref) ?? ref}`;
  if (v === null) return "null";
  if (typeof v === "bigint") return `${v}n`;
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).join(", ")}}`;
  if (typeof v === "object") return toCompactDebugString(v);
  if (typeof v === "string") {
    return v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
  }
  return String(v);
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
    } else if (isPlainObject(x)) {
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
  if (isPlainObject(v)) {
    return Object.values(v).reduce<number>(
      (n, x) => n + countLinks(x, maxDepth - 1),
      0,
    );
  }
  return 0;
}
