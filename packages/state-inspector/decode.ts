// Decoding stored Fabric values into an inspectable form.
//
// Reality check (verified against real space DBs, 2026-06-26): today's stored
// `revision.data` is plain JSON with inline *sigil links* of the legacy form
//   { "/": { "link@1": { id, space?, path?, scope?, schema? } } }
// entity references of the form
//   { "/": "of:baedrei…" }   (or { "/": "fid1:…" } in modern cell-rep)
// and streams of the form
//   { "$stream": true }
//
// So decoding for current DBs is pure JSON walking + recognition — no live
// runtime/Cell needed. The modern `fvj1:`-prefixed codec-json envelope
// (@commonfabric/data-model/codec-json) is NOT what lands in these rows; if we
// later meet it we can plug `valueFromJson` in at the leaves.

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

/** A sigil link: `{ "/": { "link@N": {...} } }`. */
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

  const link = parseSigilLink(v);
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

  if (Array.isArray(v)) return v.map((x) => annotate(x, maxDepth - 1));
  if (isPlainObject(v)) {
    const out: Record<string, Json> = {};
    for (const [k, val] of Object.entries(v)) out[k] = annotate(val, maxDepth - 1);
    return out;
  }
  return v;
}

/** Compact one-line summary of any value, for table cells. */
export function summarize(v: Json): string {
  const link = parseSigilLink(v);
  if (link) return summarizeLink(link);
  if (isStream(v)) return "⊙ stream";
  const ref = parseEntityRef(v);
  if (ref !== null) return `#${shortId(ref) ?? ref}`;
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).join(", ")}}`;
  if (typeof v === "string") return v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
  return String(v);
}

/** Count links reachable in a value (a cheap fan-out proxy). */
export function countLinks(v: Json, maxDepth = 8): number {
  if (maxDepth < 0) return 0;
  if (parseSigilLink(v)) return 1;
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
