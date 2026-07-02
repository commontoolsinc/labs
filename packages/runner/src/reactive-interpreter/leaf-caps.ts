/**
 * Capture-time LEAF CAPABILITY analysis — the v1 static scans
 * (extract.ts liveLeaf* on the #4298 branch) ported as builder-time caps
 * (02-ir.md §2.5). Computed once per leaf at ROG construction from the LIVE
 * function source + declared schemas; consumed by the dispatch as FAIL-CLOSED
 * gates (NG-2: a set bit can only force a fallback/boundary, never grant).
 *
 * Conservative by construction throughout: a false positive only causes an
 * always-sound legacy fallback, never a mis-evaluation.
 */

import type { LeafCaps } from "./rog.ts";

/** Callees provably not pattern factories (constructors/coercions/host fns)
 * plus control-flow keywords the bare-call regex would otherwise see as
 * `name(`. */
const PURE_GLOBAL_CALLEES = new Set([
  // constructors / coercions
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  // numeric / parsing host functions
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "structuredClone",
  // control-flow keywords the regex could see as `name(`
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "typeof",
  "await",
  "function",
  "do",
  "else",
]);

/** True iff a declared resultSchema pins a CONCRETE JSON value shape — the
 * precise discriminator that frees a typed value-producer leaf to call
 * closed-over pure helpers without tripping the bare-call gate (a
 * pattern-returning lift carries an EMPTY schema, verified empirically in
 * v1). */
export function resultSchemaDeclaresValueType(schema: unknown): boolean {
  if (schema === true) return false; // "any" — not a pinned value type
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const s = schema as Record<string, unknown>;
  if (s.type === "array") {
    if (resultSchemaDeclaresValueType(s.items)) return true;
    const prefix = s.prefixItems;
    if (
      Array.isArray(prefix) && prefix.length > 0 &&
      prefix.every((p) => resultSchemaDeclaresValueType(p))
    ) {
      return true;
    }
    return false;
  }
  if (typeof s.type === "string") return true;
  if (Array.isArray(s.type) && s.type.length > 0) return true;
  if (Array.isArray(s.enum) && s.enum.length > 0) return true;
  if (Object.prototype.hasOwnProperty.call(s, "const")) return true;
  if (typeof s.$ref === "string") return true;
  for (const key of ["anyOf", "allOf", "oneOf"] as const) {
    const branch = s[key];
    if (
      Array.isArray(branch) && branch.length > 0 &&
      branch.every((b) => resultSchemaDeclaresValueType(b))
    ) {
      return true;
    }
  }
  return false;
}

/** True iff a schema (or any sub-schema) declares an asCell/asStream position
 * — the leaf receives a live HANDLE the plain deep-resolved read cannot
 * provide. `default` holds an authored VALUE, not a sub-schema. */
export function schemaNeedsCellContext(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  if (Array.isArray(schema)) {
    return schema.some((s) => schemaNeedsCellContext(s));
  }
  const obj = schema as Record<string, unknown>;
  if (obj.asCell !== undefined || obj.asStream !== undefined) return true;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "default") continue;
    if (schemaNeedsCellContext(v)) return true;
  }
  return false;
}

function sourceOf(impl: unknown): string | undefined {
  try {
    return Function.prototype.toString.call(impl);
  } catch {
    return undefined;
  }
}

/** The combined v1 hazard scan: async bodies, cross-space/scope factory
 * routing, transpiled indirect calls, and bare calls to non-pure callees.
 *
 * v2 DELIBERATELY DROPS v1's schema-based suppression of the bare-call
 * branch (`resultSchemaDeclaresValueType`): its premise — "a graph-returning
 * lift carries an empty result schema" — is empirically violated by a lift
 * whose body applies ANOTHER lift factory (`lift(args => multiply(args))`
 * with a declared `{type:"number"}` schema returns a live graph NODE typed
 * by its value). With plan-time-only fallback, a suppressed false negative
 * is a SILENT wrong value; without suppression it is only lost engagement
 * (census `leaf_caps:instantiatesPattern`). Engagement recovery needs a
 * sounder discriminator (e.g. compiler-emitted callee facts, W5/W6). */
function scanInstantiatesPattern(src: string | undefined): boolean {
  if (src === undefined) return false; // other gates / loud crashes cover it
  if (/\.(inSpace|asScope)\s*\(/.test(src)) return true;
  if (/^async[\s(]/.test(src.trimStart())) return true;
  // CommonJS interop indirect call `(0, exports.child)(...)`.
  if (/\(\s*0\s*,[^)]*\)\s*\(/.test(src)) return true;
  const callRe = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of src.matchAll(callRe)) {
    if (!PURE_GLOBAL_CALLEES.has(m[1])) return true;
  }
  return false;
}

/** `.for(` named-cell mint — needs a builder frame the interpreter's
 * synthetic node does not provide. */
function scanNeedsBuilderContext(src: string | undefined): boolean {
  return src !== undefined && /\.for\s*\(/.test(src);
}

/** Write methods on a Cell/Stream input handle — an EFFECTFUL leaf. Source
 * unreadable ⇒ conservative true. */
function scanWritesCellInput(src: string | undefined): boolean {
  if (src === undefined) return true;
  return /\.\s*(set|send|update|push|setRaw|setRawUntyped|setMetaRaw|exec)\s*\(/
    .test(src);
}

/** Handle-READ member calls (`.get(`/`.sample(`) — the body expects a live
 * Cell even when the argument schema doesn't declare one (untyped lifts).
 * Conservative superset of the schema scan; v2 addition (v1's dry-run value
 * guard covered this class before probes went structural). */
function scanReadsCellHandle(src: string | undefined): boolean {
  return src !== undefined && /\.\s*(get|sample)\s*\(/.test(src);
}

/** Compute the fail-closed capability annotations for one live leaf. */
export function computeLeafCaps(
  impl: unknown,
  argumentSchema: unknown,
  _resultSchema: unknown,
): LeafCaps | undefined {
  const src = sourceOf(impl);
  const caps: LeafCaps = {};
  if (scanInstantiatesPattern(src)) {
    caps.instantiatesPattern = true;
  }
  if (src !== undefined && /^async[\s(]/.test(src.trimStart())) {
    caps.async = true;
  }
  if (
    schemaNeedsCellContext(argumentSchema) || scanReadsCellHandle(src) ||
    scanNeedsBuilderContext(src)
  ) {
    caps.needsCellContext = true;
  }
  if (caps.needsCellContext && scanWritesCellInput(src)) {
    caps.writesInput = true;
  }
  return Object.keys(caps).length > 0 ? caps : undefined;
}
