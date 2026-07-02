// CFC Phase 3: the per-row label rule — builder helpers, the serialized AST,
// authoring/wire validation, and the shared evaluator.
// (Spec: docs/specs/sqlite-builtin/06-cfc.md, "Per-row labels".)
//
// A rule is a PURE declarative projection over (stored columns, fixed db
// properties): the builders below return plain-JSON AST nodes, `table()`
// validates and attaches the result to the table schema as `rowLabel`, and
// `evaluateRowLabel` interprets it identically at the write gate, the server
// commit, and read re-derivation. There is deliberately NO acting-principal
// term (a read-time `currentUser()` would resolve to the *reader* — in an
// OR-clause that self-grants access; the acting user belongs in the result
// ceiling). `any(...)` evaluates to one authored OR-clause `{anyOf:[…]}` — any
// single alternative can read (CFC spec §18.5.3 / §3.1.8, Epic E1). The
// runner's clause-aware label profile enforces subsumption at the boundary and
// rejects non-principal-like alternatives (Caveat/Expires); this evaluator
// keeps the disjunction structural, never silently lowered to conjunctive
// atoms.
//
// Pure module: no FFI, no engine imports — safe for client-side import.

/** A reference to a declared column, handed to the rule as `f.<col>`. */
export interface FieldRef {
  field: string;
}

export interface MatchOpts {
  /** Capture group to extract instead of the whole match. */
  group?: number;
  /** Minimum number of matches; fewer fails closed (required anchor). */
  min?: number;
}

/** Serialized rule, attached to the table schema as `rowLabel`. */
export interface RowLabelSpec {
  version: 1;
  confidentiality?: unknown;
  integrity?: unknown;
}

/** Field handles passed to the rule: one accessor per declared column. */
export type RowFieldHandles<C extends Record<string, unknown>> =
  & { [K in keyof C]: FieldRef }
  & Record<string, FieldRef>;

export type RowLabelRule<C extends Record<string, unknown>> = (
  f: RowFieldHandles<C>,
) => { confidentiality?: unknown; integrity?: unknown };

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isFieldRef = (x: unknown): x is FieldRef =>
  isRecord(x) && typeof x.field === "string" && Object.keys(x).length === 1;

// ---------------------------------------------------------------------------
// Builders — each returns its serialized AST node.
// ---------------------------------------------------------------------------

/**
 * Run `re` (forced global) over a column's text ⟹ the ordered list of matches
 * (or capture `group`). The universal field extractor: splits a dirty
 * `Name <addr>, addr` recipient line for free. Strict-if-present: a non-empty
 * value yielding zero matches fails closed at evaluation (never under-label);
 * `min` makes the field a required anchor.
 */
export function match(
  field: FieldRef,
  re: RegExp,
  opts: MatchOpts = {},
): { match: Record<string, unknown> } {
  assertField(field, "match()");
  assertRegExp(re, "match()");
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const node: Record<string, unknown> = {
    field: field.field,
    source: re.source,
    flags,
  };
  if (opts.group !== undefined) node.group = opts.group;
  if (opts.min !== undefined) node.min = opts.min;
  return { match: node };
}

/**
 * Include `then` only when the regex TESTS true against the column (gate
 * trust, or a data-dependent conjunct, on extracted metadata). One fused
 * helper — a bare `when(matches(…))` pair would collide with the builder's
 * control-flow `when`, whose transformer lowering matches by NAME and mangles
 * any local so named.
 */
export function whenMatches(
  field: FieldRef,
  re: RegExp,
  then: unknown,
): { when: unknown; then: unknown } {
  assertField(field, "whenMatches()");
  assertRegExp(re, "whenMatches()");
  return {
    when: {
      match: {
        field: field.field,
        source: re.source,
        flags: re.flags.replace("g", ""),
      },
    },
    then,
  };
}

/** `did:<protocol>:<v>` for each extracted `v` (distributes over the match
 *  list). Normalization is protocol-implied: mailto/web lowercase+trim,
 *  did:key untouched (base58 is case-sensitive), unknown protocols identity. */
export function principal(
  protocol: string,
  of: { match: Record<string, unknown> },
): { principal: Record<string, unknown> } {
  if (typeof protocol !== "string" || !/^[a-z][a-z0-9.+-]*$/.test(protocol)) {
    throw new TypeError(
      `principal(): invalid DID protocol ${JSON.stringify(protocol)}`,
    );
  }
  if (!isRecord(of) || !isRecord(of.match)) {
    throw new TypeError("principal() takes a match(...) term");
  }
  return { principal: { protocol, of } };
}

/** The db's owner — the principal that created the SqliteDb cell, resolved
 *  from the db ref. A FIXED db property, so the rule stays pure. */
export function dbOwner(): { dbOwner: true } {
  return { dbOwner: true };
}

/** A literal atom (escape hatch). (Named `constant` — `const` is reserved.) */
export function constant(atom: unknown): { constant: unknown } {
  return { constant: atom };
}

/** Separate conjunctive clauses, one per atom — today's only confidentiality
 *  combinator (every principal an independent requirement). */
export function all(...terms: unknown[]): { allOf: unknown[] } {
  return { allOf: terms };
}

/** ONE authored OR-clause: any alternative satisfies it (CFC spec §3.1.8).
 *  Serializes, but `table()` REJECTS it until the runtime ships the
 *  clause-aware label profile — never silently lowered to all-of. */
export function any(...terms: unknown[]): { anyOf: unknown[] } {
  return { anyOf: terms };
}

/** Set-intersection over integrity atom sets (the trust-floor meet).
 *  Integrity only — confidentiality combines by all()/any(). */
export function intersect(...terms: unknown[]): { intersect: unknown[] } {
  return { intersect: terms };
}

/** Integrity claim: the row was authored by the extracted principal. Minted as
 *  a self-describing `claimed-authored-by` atom — content-derived provenance
 *  is forgeable by the row's writer, so it never lowers to the trusted
 *  `AuthoredBy` family directly (see 06-cfc.md; upgrade via provider trust). */
export function authoredBy(
  p: { principal: Record<string, unknown> },
): { authoredBy: unknown } {
  assertPrincipal(p, "authoredBy()");
  return { authoredBy: p };
}

/** Integrity claim: endorsed by the extracted principal (same downgrade rule
 *  as `authoredBy`). */
export function endorsedBy(
  p: { principal: Record<string, unknown> },
): { endorsedBy: unknown } {
  assertPrincipal(p, "endorsedBy()");
  return { endorsedBy: p };
}

function assertField(x: unknown, who: string): asserts x is FieldRef {
  if (!isFieldRef(x)) {
    throw new TypeError(`${who} takes a field handle (f.<column>)`);
  }
}
function assertRegExp(x: unknown, who: string): asserts x is RegExp {
  if (!(x instanceof RegExp)) throw new TypeError(`${who} takes a RegExp`);
}
function assertPrincipal(x: unknown, who: string) {
  if (!isRecord(x) || !isRecord(x.principal)) {
    throw new TypeError(`${who} takes a principal(...) term`);
  }
}

// ---------------------------------------------------------------------------
// Validation — fail closed at authoring AND on wire-supplied specs.
// ---------------------------------------------------------------------------

const MAX_REGEX_SOURCE = 512;

/** Reject ReDoS-shaped patterns: a quantifier applied to a group that itself
 *  contains an unbounded quantifier (star height ≥ 2), e.g. `(a+)+`. Linear
 *  scan honoring escapes and character classes. Conservative lint, not a
 *  parser; the per-eval input is additionally produced by the row itself. */
function regexLintReason(source: string): string | undefined {
  if (source.length > MAX_REGEX_SOURCE) {
    return `regex too long (${source.length} > ${MAX_REGEX_SOURCE})`;
  }
  const QUANT = new Set(["*", "+", "{", "?"]);
  // Stack of group frames; [0] is the top level. hasQuant = an unbounded
  // quantifier occurred directly inside this frame (or a nested one).
  const stack: { hasQuant: boolean }[] = [{ hasQuant: false }];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++; // skip escaped char
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      stack.push({ hasQuant: false });
      continue;
    }
    if (c === ")") {
      const frame = stack.pop();
      if (frame === undefined || stack.length === 0) {
        // Unmatched ")" — invalid regex; report a reason rather than crash
        // (the lint runs on hostile wire specs and must stay fail-closed).
        return "regex fails the safety lint (unbalanced parenthesis)";
      }
      const next = source[i + 1];
      if (frame.hasQuant && next !== undefined && QUANT.has(next)) {
        return "regex fails the safety lint (nested quantifier — ReDoS risk)";
      }
      stack[stack.length - 1].hasQuant ||= frame.hasQuant;
      continue;
    }
    if (QUANT.has(c)) stack[stack.length - 1].hasQuant = true;
  }
  return undefined;
}

// Validate an `any(...)` node: every alternative must be a valid confidentiality
// term (Epic E1). Atom-shape restrictions on alternatives (principal-like only;
// no Caveat/Expires) are enforced runner-side at the boundary (§3.1.8), so this
// only checks structural well-formedness of each alternative.
function validateConfAnyOf(
  node: Record<string, unknown>,
  columns: ReadonlySet<string>,
): string | undefined {
  const terms = node.anyOf;
  if (!Array.isArray(terms) || terms.length === 0) {
    return "any() needs at least one alternative";
  }
  for (const t of terms) {
    const r = validateConfTerm(t, columns);
    if (r) return r;
  }
  return undefined;
}

function validateMatchNode(
  node: unknown,
  columns: ReadonlySet<string>,
  who: string,
): string | undefined {
  if (!isRecord(node)) return `${who}: malformed match node`;
  const { field, source, flags, group, min } = node;
  if (typeof field !== "string") return `${who}: match without a field`;
  if (!columns.has(field)) {
    return `rule references unknown column "${field}"`;
  }
  if (typeof source !== "string") return `${who}: match without a source`;
  const lint = regexLintReason(source);
  if (lint) return lint;
  if (typeof flags !== "string" || !/^[dgimsuvy]*$/.test(flags)) {
    return `${who}: invalid regex flags`;
  }
  try {
    new RegExp(source, flags);
  } catch {
    return `${who}: invalid regex ${JSON.stringify(source)}`;
  }
  if (
    group !== undefined && (!Number.isInteger(group) || (group as number) < 0)
  ) {
    return `${who}: invalid capture group`;
  }
  if (min !== undefined && (!Number.isInteger(min) || (min as number) < 0)) {
    return `${who}: invalid min`;
  }
  return undefined;
}

function validatePrincipalNode(
  node: unknown,
  columns: ReadonlySet<string>,
): string | undefined {
  if (!isRecord(node) || typeof node.protocol !== "string") {
    return "malformed principal node";
  }
  if (!/^[a-z][a-z0-9.+-]*$/.test(node.protocol)) {
    return `invalid DID protocol ${JSON.stringify(node.protocol)}`;
  }
  const of = node.of;
  if (!isRecord(of) || !("match" in of)) {
    return "principal() takes a match(...) term";
  }
  return validateMatchNode(of.match, columns, "principal");
}

function unknownOp(node: Record<string, unknown>, position: string): string {
  return `unknown rowLabel op in ${position} position: ` +
    `{${Object.keys(node).join(", ")}}`;
}

function validateConfTerm(
  node: unknown,
  columns: ReadonlySet<string>,
): string | undefined {
  if (!isRecord(node)) return "malformed confidentiality term";
  if ("anyOf" in node) return validateConfAnyOf(node, columns);
  if ("intersect" in node) {
    return "intersect() is integrity-only (the trust-floor meet); " +
      "confidentiality combines by all() — and any() once OR-clauses land";
  }
  if ("authoredBy" in node || "endorsedBy" in node) {
    return "authoredBy()/endorsedBy() are integrity terms, not confidentiality";
  }
  if ("allOf" in node) return validateConfExpr(node, columns);
  if ("principal" in node) {
    return validatePrincipalNode(node.principal, columns);
  }
  if ("dbOwner" in node) {
    return node.dbOwner === true ? undefined : "malformed dbOwner node";
  }
  if ("constant" in node) return undefined;
  if ("when" in node) {
    const test = (node as { when?: unknown }).when;
    const r = isRecord(test) && "match" in test
      ? validateMatchNode(test.match, columns, "when")
      : "malformed when gate (use whenMatches())";
    if (r) return r;
    return validateConfTerm((node as { then?: unknown }).then, columns);
  }
  return unknownOp(node, "confidentiality");
}

function validateConfExpr(
  node: unknown,
  columns: ReadonlySet<string>,
): string | undefined {
  if (!isRecord(node)) return "malformed confidentiality expression";
  if ("anyOf" in node) return validateConfAnyOf(node, columns);
  if ("allOf" in node) {
    const terms = node.allOf;
    if (!Array.isArray(terms) || terms.length === 0) {
      return "all() needs at least one term";
    }
    for (const t of terms) {
      const r = validateConfTerm(t, columns);
      if (r) return r;
    }
    return undefined;
  }
  return validateConfTerm(node, columns);
}

function validateIntegTerm(
  node: unknown,
  columns: ReadonlySet<string>,
): string | undefined {
  if (!isRecord(node)) return "malformed integrity term";
  if ("anyOf" in node) {
    return "disjunctive integrity does not exist (CFC spec §3.1.8): " +
      "integrity is a conjunction combined by meet";
  }
  if ("authoredBy" in node || "endorsedBy" in node) {
    const inner = (node.authoredBy ?? node.endorsedBy) as unknown;
    if (!isRecord(inner) || !("principal" in inner)) {
      return "authoredBy()/endorsedBy() take a principal(...) term";
    }
    return validatePrincipalNode(inner.principal, columns);
  }
  if ("intersect" in node || "allOf" in node) {
    const terms = (node.intersect ?? node.allOf) as unknown;
    if (!Array.isArray(terms) || terms.length === 0) {
      return "intersect()/all() need at least one term";
    }
    for (const t of terms) {
      const r = validateIntegTerm(t, columns);
      if (r) return r;
    }
    return undefined;
  }
  if ("when" in node) {
    const test = node.when;
    const r = isRecord(test) && "match" in test
      ? validateMatchNode(test.match, columns, "when")
      : "malformed when gate (use whenMatches())";
    if (r) return r;
    return validateIntegTerm((node as { then?: unknown }).then, columns);
  }
  if ("constant" in node) return undefined;
  return unknownOp(node, "integrity");
}

/**
 * Validate a rowLabel spec against the declared column names. Returns the
 * failure reason, or undefined when valid. Used by `table()` at authoring
 * (throws) and MUST be re-run on wire-supplied specs before evaluation —
 * "couldn't validate" is never "no label".
 */
export function validateRowLabelSpec(
  spec: unknown,
  columns: readonly string[],
): string | undefined {
  if (!isRecord(spec)) return "rowLabel spec must be an object";
  if (spec.version !== 1) {
    return `unsupported rowLabel version ${JSON.stringify(spec.version)}`;
  }
  const cols = new Set(columns);
  if (spec.confidentiality === undefined && spec.integrity === undefined) {
    return "rowLabel rule must declare confidentiality and/or integrity";
  }
  if (spec.confidentiality !== undefined) {
    const r = validateConfExpr(spec.confidentiality, cols);
    if (r) return r;
  }
  if (spec.integrity !== undefined) {
    const r = validateIntegTerm(spec.integrity, cols);
    if (r) return r;
  }
  return undefined;
}

/** Build + validate the serialized spec from an authored rule. Throws on any
 *  violation (fail closed at definition time). Called by `table()`. */
export function buildRowLabelSpec<C extends Record<string, unknown>>(
  columns: readonly string[],
  rule: RowLabelRule<C>,
): RowLabelSpec {
  const handles = Object.fromEntries(
    columns.map((name) => [name, { field: name }]),
  ) as RowFieldHandles<C>;
  const out = rule(handles);
  if (!isRecord(out)) {
    throw new TypeError(
      "table(): a rowLabel rule must return { confidentiality?, integrity? }",
    );
  }
  const spec: RowLabelSpec = { version: 1 };
  if (out.confidentiality !== undefined) {
    spec.confidentiality = out.confidentiality;
  }
  if (out.integrity !== undefined) spec.integrity = out.integrity;
  const reason = validateRowLabelSpec(spec, columns);
  if (reason) {
    throw new TypeError(`table(): invalid rowLabel rule — ${reason}`);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Evaluation — one pure function, shared by write gate, server, and read.
// ---------------------------------------------------------------------------

class RowLabelEvalError extends Error {}

const fail = (msg: string): never => {
  throw new RowLabelEvalError(msg);
};

/** Stable structural key for dedup (atoms are small plain JSON). */
function atomKey(v: unknown): string {
  if (typeof v === "string") return `s:${v}`;
  return `j:${
    JSON.stringify(v, (_k, val) =>
      isRecord(val)
        ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
        : val)
  }`;
}

function dedup(atoms: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const a of atoms) {
    const k = atomKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

function normalizeForProtocol(protocol: string, v: string): string {
  switch (protocol) {
    case "mailto":
    case "web":
      return v.trim().toLowerCase();
    default:
      // did:key is base58 (case-sensitive); unknown protocols: do nothing.
      return v;
  }
}

/** Extract the match list for a field per the strict-if-present contract. */
function evalMatch(
  node: Record<string, unknown>,
  row: Record<string, unknown>,
): string[] {
  const field = node.field as string;
  if (!(field in row)) {
    return fail(`rule input field "${field}" is absent from the row`);
  }
  const value = row[field];
  const values: string[] = [];
  if (value !== null && value !== undefined && value !== "") {
    if (typeof value !== "string") {
      return fail(
        `field "${field}" is ${typeof value}, not a string — regex input`,
      );
    }
    // Force the global flag like match() does at authoring: matchAll throws
    // on non-global regexes, and a hostile/legacy wire spec must degrade to
    // the documented split semantics, not an uncaught exception.
    const rawFlags = typeof node.flags === "string" ? node.flags : "";
    const flags = rawFlags.includes("g") ? rawFlags : rawFlags + "g";
    const re = new RegExp(node.source as string, flags);
    const group = node.group as number | undefined;
    for (const m of value.matchAll(re)) {
      const picked = group !== undefined ? m[group] : m[0];
      if (typeof picked === "string") values.push(picked);
    }
    if (values.length === 0) {
      // Strict-if-present: a populated field that yields nothing would
      // silently drop real principals (under-labeling). Fail closed.
      return fail(
        `field "${field}" is non-empty but matched nothing — refusing to ` +
          "under-label (strict-if-present)",
      );
    }
  }
  const min = node.min as number | undefined;
  if (min !== undefined && values.length < min) {
    return fail(
      `field "${field}" yielded ${values.length} match(es); rule requires ` +
        `at least ${min}`,
    );
  }
  return values;
}

function evalTest(
  test: unknown,
  row: Record<string, unknown>,
): boolean {
  if (!isRecord(test) || !isRecord(test.match)) {
    return fail("malformed when gate (use whenMatches())");
  }
  const { field, source, flags } = test.match as Record<string, unknown>;
  if (typeof field !== "string" || !(field in row)) {
    return fail(`rule input field "${String(field)}" is absent from the row`);
  }
  const value = row[field];
  if (value === null || value === undefined || value === "") return false;
  if (typeof value !== "string") {
    return fail(
      `field "${field}" is ${typeof value}, not a string — regex input`,
    );
  }
  return new RegExp(source as string, (flags as string) ?? "").test(value);
}

function evalPrincipal(
  node: Record<string, unknown>,
  row: Record<string, unknown>,
): string[] {
  const protocol = node.protocol as string;
  const of = node.of as { match: Record<string, unknown> };
  return evalMatch(of.match, row).map(
    (v) => `did:${protocol}:${normalizeForProtocol(protocol, v)}`,
  );
}

function evalConf(
  node: unknown,
  row: Record<string, unknown>,
  ctx: { dbOwner?: string },
): unknown[] {
  if (!isRecord(node)) return fail("malformed confidentiality term");
  if ("anyOf" in node) {
    const terms = node.anyOf;
    if (!Array.isArray(terms)) return fail("malformed any()");
    // One OR-clause: the alternatives are the union of what each term
    // evaluates to (a `principal(match)` may yield several). The clause is
    // ONE element of the row's conjunctive confidentiality list, so an
    // enclosing `all(...)` concatenates it with sibling clauses
    // (`all(any(A,B), C)` → `[{anyOf:[A,B]}, C]` = (A∨B)∧C). Kept structural,
    // never flattened into bare atoms (Epic E1, CFC spec §3.1.8).
    const alternatives = terms.flatMap((t) => evalConf(t, row, ctx));
    return [{ anyOf: alternatives }];
  }
  if ("allOf" in node) {
    const terms = node.allOf;
    if (!Array.isArray(terms)) return fail("malformed all()");
    return terms.flatMap((t) => evalConf(t, row, ctx));
  }
  if ("principal" in node) {
    return evalPrincipal(node.principal as Record<string, unknown>, row);
  }
  if ("dbOwner" in node) {
    return ctx.dbOwner !== undefined ? [ctx.dbOwner] : fail(
      "dbOwner() has no owner in the evaluation context",
    );
  }
  if ("constant" in node) return [node.constant];
  if ("when" in node) {
    return evalTest(node.when, row)
      ? evalConf((node as { then?: unknown }).then, row, ctx)
      : [];
  }
  return fail(unknownOp(node, "confidentiality"));
}

function evalInteg(
  node: unknown,
  row: Record<string, unknown>,
  ctx: { dbOwner?: string },
): unknown[] {
  if (!isRecord(node)) return fail("malformed integrity term");
  if ("anyOf" in node) return fail("disjunctive integrity does not exist");
  if ("authoredBy" in node || "endorsedBy" in node) {
    const kind = "authoredBy" in node
      ? "claimed-authored-by"
      : "claimed-endorsed-by";
    const inner = (node.authoredBy ?? node.endorsedBy) as Record<
      string,
      unknown
    >;
    const subjects = evalPrincipal(
      inner.principal as Record<string, unknown>,
      row,
    );
    if (subjects.length > 1) {
      return fail(
        `${subjects.length} matches in an integrity-bearing position — a ` +
          "provenance subject must be unique (display-name bait); fail closed",
      );
    }
    // Zero matches: the claim simply is not made (distinct from >1 = error).
    return subjects.map((subject) => ({ kind, subject }));
  }
  if ("intersect" in node) {
    const terms = node.intersect;
    if (!Array.isArray(terms) || terms.length === 0) {
      return fail("malformed intersect()");
    }
    const lists = terms.map((t) => evalInteg(t, row, ctx));
    return lists.reduce((acc, list) => {
      const keys = new Set(list.map(atomKey));
      return acc.filter((a) => keys.has(atomKey(a)));
    });
  }
  if ("allOf" in node) {
    const terms = node.allOf;
    if (!Array.isArray(terms)) return fail("malformed all()");
    return terms.flatMap((t) => evalInteg(t, row, ctx));
  }
  if ("when" in node) {
    return evalTest(node.when, row)
      ? evalInteg((node as { then?: unknown }).then, row, ctx)
      : [];
  }
  if ("constant" in node) return [node.constant];
  return fail(unknownOp(node, "integrity"));
}

/**
 * Evaluate a rowLabel spec against a row's column values. Fail-closed: any
 * unresolvable input, malformed node, or policy violation returns `{error}` —
 * never a partial label. Callers turn `{error}` into a refused query /
 * rejected write.
 */
export function evaluateRowLabel(
  spec: RowLabelSpec,
  row: Record<string, unknown>,
  ctx: { dbOwner?: string },
):
  | { confidentiality: unknown[]; integrity: unknown[] }
  | { error: string } {
  if (!isRecord(spec) || spec.version !== 1) {
    return {
      error: `unsupported rowLabel version ${
        JSON.stringify(isRecord(spec) ? spec.version : spec)
      }`,
    };
  }
  try {
    const confidentiality = spec.confidentiality !== undefined
      ? dedup(evalConf(spec.confidentiality, row, ctx))
      : [];
    const integrity = spec.integrity !== undefined
      ? dedup(evalInteg(spec.integrity, row, ctx))
      : [];
    return { confidentiality, integrity };
  } catch (error) {
    if (error instanceof RowLabelEvalError) return { error: error.message };
    throw error;
  }
}

/** The rule attached to a (possibly wire-supplied) table schema, or undefined.
 *  Presence gates all Phase 3 work, so rule-less tables pay nothing. */
export function rowLabelSpecOf(tableSchema: unknown): RowLabelSpec | undefined {
  if (!isRecord(tableSchema)) return undefined;
  const spec = tableSchema.rowLabel;
  return isRecord(spec) ? spec as unknown as RowLabelSpec : undefined;
}

/**
 * The column names a rule reads (its input columns), in walk order, deduped.
 * The read side locates each of these in the projection by TRUE origin
 * `(table, column)` — never by output name — and refuses when one is missing
 * or ambiguous.
 */
export function ruleInputFields(spec: RowLabelSpec): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (!isRecord(n)) return;
    const m = n.match;
    if (isRecord(m) && typeof m.field === "string" && !seen.has(m.field)) {
      seen.add(m.field);
      out.push(m.field);
    }
    for (const v of Object.values(n)) walk(v);
  };
  walk(spec.confidentiality);
  walk(spec.integrity);
  return out;
}
