/**
 * Builds the Enter "info card": a structured, colourised summary of a structure
 * node assembled from its extracted {@link NodeMeta}, the navigation tree, and
 * cross-references — i.e. information that is NOT obvious from the raw source.
 * The verbatim source is returned alongside so the overlay can toggle to it.
 *
 * Pure: produces model {@link Line}s (the same shape the renderer already draws)
 * with token classes chosen so the existing theme colours everything coherently.
 */
import type {
  Document,
  Line,
  SchemaField,
  SchemaMeta,
  Span,
  StructureNode,
  TokenClass,
} from "./model.ts";
import {
  ancestorsOf,
  collectIdentUses,
  type Dependency,
  findDependencies,
  findReferences,
} from "./references.ts";
import { basename } from "@std/path";
import { cpLen } from "./ansi.ts";
import { describeSynthetic } from "./vocab.ts";
import type { Semantics } from "./semantics.ts";

/** A selectable cross-reference line that jumps the main view when invoked. */
export interface CardTarget {
  /** Index into the card's `info` lines (for highlight + reveal). */
  readonly cardLine: number;
  /** Destination line/column in the main document. */
  readonly destLine: number;
  readonly destCol: number;
  /** Char offset of the declaration to select, when the target is a definition. */
  readonly defOffset?: number;
  /** End offset of that declaration. Diff views clamp nested nodes to the same
   * start offset, so the end disambiguates which node to select. */
  readonly defEndOffset?: number;
  /** External file to open, when the definition lives outside the blob; with
   * `destLine` the line within that file. */
  readonly filePath?: string;
  /** A "… N more" line: selecting it and pressing Enter rebuilds the card with
   * every truncated list shown in full, rather than navigating anywhere. */
  readonly expand?: boolean;
}

/** A target relative to a section's own line array (offset into the card later). */
interface TargetRel {
  readonly relLine: number;
  readonly destLine: number;
  readonly destCol: number;
  readonly defOffset?: number;
  readonly defEndOffset?: number;
  readonly filePath?: string;
  readonly expand?: boolean;
}

interface Section {
  readonly lines: Line[];
  readonly targets: TargetRel[];
}

export interface PeekCard {
  readonly title: string;
  readonly info: Line[];
  readonly source: Line[];
  readonly targets: CardTarget[];
}

const MAX_CHILDREN = 14;
const MAX_USES = 10;
const MAX_DEPS = 10;

export function buildPeekCard(
  doc: Document,
  node: StructureNode,
  semantics?: Semantics,
  expanded = false,
): PeekCard {
  const info: Line[] = [];
  const targets: CardTarget[] = [];

  // Best-effort inferred type for a value binding — the answer to "what will
  // this be?". Covers every named binding the checker can type: plain
  // variables, builder/pattern call results, and object literals. The semantic
  // type wins; the syntactic type read from the source is the fallback.
  const inferredType =
    node.nameOffset !== undefined && isValueBinding(node.kind)
      ? semantics?.typeAt(node.nameOffset) ?? undefined
      : undefined;
  const syntacticType = node.meta?.kind === "variable"
    ? node.meta.typeText
    : undefined;
  const typeText = inferredType ?? syntacticType;

  const append = (section: Section) => {
    if (section.lines.length === 0) return;
    const base = info.length;
    for (const t of section.targets) {
      targets.push({
        cardLine: base + t.relLine,
        destLine: t.destLine,
        destCol: t.destCol,
        defOffset: t.defOffset,
        defEndOffset: t.defEndOffset,
        filePath: t.filePath,
        expand: t.expand,
      });
    }
    info.push(...section.lines, BLANK);
  };

  info.push(metaLine(node));
  // When several AST nodes share this exact range, name them all so the merged
  // node's full identity is visible.
  if (node.astKinds && node.astKinds.length > 1) {
    info.push(
      row(["merges  ", "comment"], [node.astKinds.join(" · "), "typeName"]),
    );
  }
  const origin = originLine(node);
  if (origin) info.push(origin);
  if (typeText) {
    info.push(row(["type  ", "comment"], [typeText, "typeKeyword"]));
  }
  const crumb = breadcrumb(doc, node);
  if (crumb) info.push(crumb);
  info.push(BLANK);

  const detail = detailSection(doc, node);
  if (detail.length > 0) info.push(...detail, BLANK);

  append(outlineSection(node, expanded));
  append(usesSection(doc, node, expanded));
  append(depsSection(doc, node, semantics, expanded));
  append(externalSection(doc, node, semantics, expanded));

  // Drop a trailing blank for tidiness.
  while (info.length > 0 && info[info.length - 1].text === "") info.pop();

  return {
    title: cardTitle(node),
    info,
    source: doc.lines.slice(node.startLine, node.endLine + 1),
    targets,
  };
}

/** The card title. A generic AST node leads with its AST kind(s) rather than
 * the internal "node" label; a recognised shape keeps its structure kind. */
function cardTitle(node: StructureNode): string {
  if (node.kind === "node" || node.kind === "comment") {
    const k = node.astKinds && node.astKinds.length > 0
      ? node.astKinds.join(" + ")
      : node.kind;
    return `${k}  ${node.label}`;
  }
  return `${node.kind}  ${node.label}`;
}

// --- sections ----------------------------------------------------------------

function metaLine(node: StructureNode): Line {
  const span = node.endLine - node.startLine + 1;
  return row(
    [`lines ${node.startLine + 1}–${node.endLine + 1}`, "comment"],
    [`  ·  ${span} line${span === 1 ? "" : "s"}`, "comment"],
  );
}

/**
 * An origin line, but only for nodes whose name (or builder) matches the
 * transformer's own vocabulary — those are certainly generated. Everything else
 * gets no line: with no source map back to the original, authored-vs-generated
 * cannot be confirmed, so we make no claim.
 */
function originLine(node: StructureNode): Line | null {
  const probe = node.name ??
    (node.meta?.kind === "contract" ? node.meta.builder : undefined);
  const generated = probe ? describeSynthetic(probe) : null;
  if (!generated) return null;
  return row(
    ["origin  ", "comment"],
    ["transformer-generated", "cfHelper"],
    [` · ${generated}`, "comment"],
  );
}

function breadcrumb(doc: Document, node: StructureNode): Line | undefined {
  const chain = ancestorsOf(doc.flatStructure, node);
  if (chain.length === 0) return undefined;
  const parts: Part[] = [["path  ", "comment"]];
  chain.forEach((n, i) => {
    if (i > 0) parts.push([" › ", "punctuation"]);
    parts.push([crumbLabel(n), "callName"]);
  });
  return row(...parts);
}

type ContractMeta = Extract<
  NonNullable<StructureNode["meta"]>,
  { kind: "contract" }
>;

/** Node kinds that bind a named value the checker can type. */
function isValueBinding(kind: StructureNode["kind"]): boolean {
  return kind === "variable" || kind === "builder" || kind === "pattern" ||
    kind === "object";
}

function detailSection(doc: Document, node: StructureNode): Line[] {
  const meta = node.meta;
  if (!meta) return [];
  switch (meta.kind) {
    case "contract":
      return contractDetail(doc, meta);
    case "schema":
      return schemaSection("schema", meta.schema);
    case "type":
      return typeDetail(meta);
    case "closure":
      return closureDetail(meta);
    case "variable":
      return variableDetail(meta);
    case "import":
      return importDetail(meta);
  }
}

function contractDetail(doc: Document, meta: ContractMeta): Line[] {
  // A call site like `__cfLift_1({…})` carries no schemas of its own; resolve
  // the builder reference to its declaration so its contract is shown anyway.
  const { contract, borrowed } = resolveContract(doc, meta);
  const out: Line[] = [];
  const head: Part[] = [[meta.builder, "builderCall"]];
  if (contract.captures.length > 0) {
    head.push(["  captures ", "comment"], [
      `{ ${contract.captures.join(", ")} }`,
      "parameter",
    ]);
  }
  if (contract.returns && contract.returns.length > 0) {
    head.push(["  →  ", "operator"], [
      `{ ${contract.returns.join(", ")} }`,
      "propertyName",
    ]);
  }
  out.push(row(...head));
  if (borrowed) {
    out.push(row(["  ↗ contract from its declaration", "comment"]));
  }
  // Type arguments restate the input/output types, so only show them when we
  // don't already have parsed schemas to display (e.g. fetchJson<T>).
  if (
    !contract.input && !contract.output &&
    contract.typeArgs && contract.typeArgs.length > 0
  ) {
    out.push(row(
      ["type args  ", "comment"],
      ["<", "operator"],
      [contract.typeArgs.join(", "), "typeKeyword"],
      [">", "operator"],
    ));
  }
  if (contract.args && contract.args.length > 0) {
    out.push(row(["args  ", "comment"], [
      `{ ${contract.args.join(", ")} }`,
      "parameter",
    ]));
  }
  if (contract.innerBuilders.length > 0) {
    out.push(
      row(["calls  ", "comment"], [
        contract.innerBuilders.join(", "),
        "builderCall",
      ]),
    );
  }
  if (contract.input) {
    out.push(BLANK, ...schemaSection("input", contract.input));
  }
  if (contract.output) {
    out.push(BLANK, ...schemaSection("output", contract.output));
  }
  return out;
}

/** When the contract has no schemas, follow its builder name to a declaration
 * that does (e.g. the `const __cfLift_1 = lift(…)` for a call site). */
function resolveContract(
  doc: Document,
  meta: ContractMeta,
): { contract: ContractMeta; borrowed: boolean } {
  // Only the schema-bearing fields count as "its own" contract; a call site may
  // carry type args / arg keys yet still want its declaration's schemas.
  const hasOwn = meta.input || meta.output || meta.captures.length > 0 ||
    (meta.returns && meta.returns.length > 0);
  if (hasOwn) return { contract: meta, borrowed: false };
  const defs = doc.definitions.get(meta.builder);
  for (const def of defs ?? []) {
    const decl = doc.flatStructure.find((n) =>
      n.startOffset === def.startOffset && n.meta?.kind === "contract"
    );
    if (
      decl?.meta?.kind === "contract" && (decl.meta.input || decl.meta.output)
    ) {
      return { contract: decl.meta, borrowed: true };
    }
  }
  return { contract: meta, borrowed: false };
}

function typeDetail(
  meta: Extract<NonNullable<StructureNode["meta"]>, { kind: "type" }>,
): Line[] {
  if (meta.members.length === 0) {
    return meta.aliasText
      ? [row(["= ", "operator"], [meta.aliasText, "typeName"])]
      : [];
  }
  const out: Line[] = [
    heading(`${meta.form} · ${meta.members.length} members`),
  ];
  for (const m of meta.members) {
    out.push(row(
      ["  ", "plain"],
      [m.name, "propertyName"],
      [m.optional ? "?" : "", "comment"],
      [": ", "punctuation"],
      [m.type, "typeKeyword"],
    ));
  }
  return out;
}

function closureDetail(
  meta: Extract<NonNullable<StructureNode["meta"]>, { kind: "closure" }>,
): Line[] {
  const out: Line[] = [];
  if (meta.signature) {
    out.push(row(["signature  ", "comment"], [meta.signature, "typeKeyword"]));
  }
  out.push(
    row(["params  ", "comment"], [
      meta.params.length > 0 ? `( ${meta.params.join(", ")} )` : "( )",
      "parameter",
    ]),
  );
  if (meta.returns && meta.returns.length > 0) {
    out.push(
      row(["returns  ", "comment"], [
        `{ ${meta.returns.join(", ")} }`,
        "propertyName",
      ]),
    );
  }
  return out;
}

function variableDetail(
  meta: Extract<NonNullable<StructureNode["meta"]>, { kind: "variable" }>,
): Line[] {
  // The `type` line is emitted at the top of the card (semantic, else syntactic)
  // for every value binding; here we only show what it binds to.
  return [row(["binds to  ", "comment"], [meta.bindsTo, "identifier"])];
}

function importDetail(
  meta: Extract<NonNullable<StructureNode["meta"]>, { kind: "import" }>,
): Line[] {
  return [
    row(["imports  ", "comment"], [
      meta.names.join(", ") || "(side-effect)",
      "typeName",
    ]),
    row(["from  ", "comment"], [`"${meta.module}"`, "string"]),
  ];
}

/**
 * The meaningful descendants for the outline: declarations, builders, control
 * flow and the like, hoisted up through the generic expression/wrapper nodes
 * that now sit between them in the full-AST tree. So the card summarises a
 * node's real sub-structure rather than listing a lone `VariableDeclarationList`
 * or every sub-expression.
 */
function outlineChildren(node: StructureNode): StructureNode[] {
  const out: StructureNode[] = [];
  const visit = (children: readonly StructureNode[]) => {
    for (const c of children) {
      if (c.kind === "node" || c.kind === "comment") visit(c.children);
      else out.push(c);
    }
  };
  visit(node.children);
  return out;
}

/** Append a "… N more" line and mark it a selectable expand target. */
function pushMore(lines: Line[], targets: TargetRel[], n: number): void {
  targets.push({
    relLine: lines.length,
    destLine: 0,
    destCol: 0,
    expand: true,
  });
  lines.push(row(["  … ", "comment"], [`${n} more`, "comment"]));
}

function outlineSection(node: StructureNode, expanded: boolean): Section {
  const children = outlineChildren(node);
  if (children.length === 0) return { lines: [], targets: [] };
  const lines: Line[] = [heading(`outline · ${children.length}`)];
  const targets: TargetRel[] = [];
  const shown = expanded ? children : children.slice(0, MAX_CHILDREN);
  for (const child of shown) {
    const g = glyph(child.kind);
    // Avoid doubling up when the label already starts with the glyph (e.g. λ).
    const prefix = child.label.startsWith(g) ? "" : `${g} `;
    targets.push({
      relLine: lines.length,
      destLine: child.startLine,
      destCol: child.startCol,
      defOffset: child.startOffset,
      defEndOffset: child.endOffset,
    });
    lines.push(row(
      ["  ", "plain"],
      [prefix, "punctuation"],
      [child.label, "identifier"],
      [`  [${child.startLine + 1}–${child.endLine + 1}]`, "comment"],
    ));
  }
  if (children.length > shown.length) {
    pushMore(lines, targets, children.length - shown.length);
  }
  return { lines, targets };
}

function usesSection(
  doc: Document,
  node: StructureNode,
  expanded: boolean,
): Section {
  if (!node.name) return { lines: [], targets: [] };
  const refs = findReferences(doc, node.name, node);
  // In a diff view, occurrences on removed lines are the OLD side of the same
  // logical use (or uses that no longer exist) — counting them double-counts
  // every modified line, so they are excluded like drifted lines elsewhere.
  const uses = refs.filter((r) => !r.inside && doc.lines[r.line]?.bg !== "del");
  if (uses.length === 0 && refs.length <= 1) return { lines: [], targets: [] };

  const lines: Line[] = [heading(`uses · ${uses.length}`)];
  const targets: TargetRel[] = [];
  const declared = refs.find((r) => r.inside);
  if (declared) {
    lines.push(
      row(["  declared  ", "comment"], [`line ${declared.line + 1}`, "number"]),
    );
  }
  const limit = expanded ? uses.length : MAX_USES;
  for (const u of uses.slice(0, limit)) {
    targets.push({ relLine: lines.length, destLine: u.line, destCol: u.col });
    lines.push(row(
      ["  line ", "comment"],
      [`${u.line + 1}`, "number"],
      ["  ", "plain"],
      [trimContext(u.lineText), "identifier"],
    ));
  }
  if (uses.length > limit) {
    pushMore(lines, targets, uses.length - limit);
  }
  return { lines, targets };
}

function depsSection(
  doc: Document,
  node: StructureNode,
  semantics: Semantics | undefined,
  expanded: boolean,
): Section {
  const deps = findDependencies(doc, node);
  const rows: Line[] = [];
  const targets: TargetRel[] = [];
  let more = 0;
  for (const d of deps) {
    const jump = dependencyJump(doc, d, semantics);
    if (jump.external) continue; // a same-named external def; in "defined elsewhere"
    if (!expanded && rows.length >= MAX_DEPS) {
      more++;
      continue;
    }
    targets.push({
      relLine: rows.length + 1, // +1 for the heading prepended below
      destLine: jump.destLine,
      destCol: 0,
      defOffset: jump.defOffset,
      defEndOffset: jump.defEndOffset,
    });
    rows.push(row(
      ["  ", "plain"],
      [d.name, "callName"],
      ["  ", "plain"],
      [`${d.kind}`, "comment"],
      ["  line ", "comment"],
      [`${jump.destLine + 1}`, "number"],
    ));
  }
  if (rows.length === 0) return { lines: [], targets: [] };
  const lines: Line[] = [heading(`depends on · ${rows.length}`), ...rows];
  if (more > 0) pushMore(lines, targets, more);
  return { lines, targets };
}

/**
 * Where a dependency jumps to, resolved at its use site. The semantic service
 * pins the exact binding even when a name is declared in more than one section.
 * A use that actually resolves to another file is flagged `external` so the
 * "depends on" section drops it (it belongs under "defined elsewhere") rather
 * than jumping to an unrelated same-named in-blob declaration. With no service
 * (or no resolution) the name-index declaration is the fallback.
 */
function dependencyJump(
  doc: Document,
  dep: Dependency,
  semantics?: Semantics,
): {
  destLine: number;
  defOffset: number;
  defEndOffset?: number;
  external: boolean;
} {
  if (semantics) {
    const defs = semantics.definitionOf(dep.useOffset);
    const inBlob = defs.find((t) => t.blobOffset !== undefined);
    if (inBlob?.blobOffset !== undefined) {
      const node = enclosingNode(doc, inBlob.blobOffset);
      return node
        ? {
          destLine: node.startLine,
          defOffset: node.startOffset,
          defEndOffset: node.endOffset,
          external: false,
        }
        : {
          destLine: inBlob.line,
          defOffset: inBlob.blobOffset,
          external: false,
        };
    }
    if (defs.some((t) => t.filePath)) {
      return { destLine: dep.line, defOffset: dep.startOffset, external: true };
    }
  }
  return { destLine: dep.line, defOffset: dep.startOffset, external: false };
}

const MAX_EXTERNAL = 8;

/**
 * Symbols used in the node whose definition resolves to a file outside the
 * blob (e.g. a `commonfabric` export). Keyed on the use site's actual
 * resolution, not the bare name, so a symbol that shares a name with an
 * unrelated in-blob declaration still lands here. Each is a target that opens
 * that file at the definition.
 */
function externalSection(
  doc: Document,
  node: StructureNode,
  semantics: Semantics | undefined,
  expanded: boolean,
): Section {
  if (!semantics) return { lines: [], targets: [] };
  const rows: Line[] = [];
  const targets: TargetRel[] = [];
  let more = 0;
  for (const use of collectIdentUses(doc, node)) {
    const defs = semantics.definitionOf(use.useOffset);
    if (defs.some((t) => t.blobOffset !== undefined)) continue; // in-blob → deps
    const ext = defs.find((t) => t.filePath);
    if (!ext) continue;
    if (!expanded && rows.length >= MAX_EXTERNAL) {
      more++;
      continue;
    }
    targets.push({
      relLine: rows.length + 1, // +1 for the heading prepended below
      destLine: ext.line,
      destCol: 0,
      filePath: ext.filePath,
    });
    rows.push(row(
      ["  ", "plain"],
      [use.name, "callName"],
      ["  ", "comment"],
      [basename(ext.filePath!), "typeName"],
      [`:${ext.line + 1}`, "number"],
    ));
  }
  if (rows.length === 0) return { lines: [], targets: [] };
  const lines: Line[] = [
    heading(`defined elsewhere · ${rows.length}`),
    ...rows,
  ];
  if (more > 0) pushMore(lines, targets, more);
  return { lines, targets };
}

/**
 * Innermost *meaningful* structure node whose range contains `offset` — a
 * jump-to-definition should land on the declaration (a `variable`, `function`,
 * …), not the bare identifier or expression node that also starts there now
 * that the whole AST is in the tree.
 */
function enclosingNode(
  doc: Document,
  offset: number,
): StructureNode | undefined {
  let best: StructureNode | undefined;
  for (const n of doc.flatStructure) {
    if (n.kind === "node" || n.kind === "comment") continue;
    if (offset >= n.startOffset && offset < n.endOffset) {
      if (
        !best || n.endOffset - n.startOffset < best.endOffset - best.startOffset
      ) {
        best = n;
      }
    }
  }
  return best;
}

// --- schema rendering --------------------------------------------------------

// --- schema → TypeScript-like type rendering --------------------------------
//
// Schemas are shown as a type signature (`{ token: string }`, `string[]`,
// nested objects) rather than the underlying JSON-schema shape. Optional fields
// (not in `required`) get a `?`. Rendered inline when it fits, else multi-line.

const INLINE_MAX = 56;

/** A labelled schema: `input  { token: string }` inline, or a heading + block. */
function schemaSection(label: string, schema: SchemaMeta): Line[] {
  const inline = inlineSchemaParts(schema);
  const labelPart: Part = [`${label}  `, "comment"];
  if (partsLen([labelPart, ...inline]) <= INLINE_MAX) {
    return [row(labelPart, ...inline)];
  }
  return [heading(label), ...schemaMultiline(schema, 1)];
}

function inlineSchemaParts(schema: SchemaMeta): Part[] {
  if (schema.fields.length === 0 && schema.rootType !== "object") {
    return [[schema.rootType, "typeKeyword"]];
  }
  return objectInlineParts(schema.fields);
}

function objectInlineParts(fields: readonly SchemaField[]): Part[] {
  if (fields.length === 0) return [["{}", "bracket"]];
  const parts: Part[] = [["{ ", "bracket"]];
  fields.forEach((f, i) => {
    if (i > 0) parts.push(["; ", "punctuation"]);
    parts.push(
      [f.name, "schemaKey"],
      [f.required ? "" : "?", "comment"],
      [": ", "punctuation"],
      ...fieldTypeInlineParts(f),
    );
  });
  parts.push([" }", "bracket"]);
  return parts;
}

function fieldTypeInlineParts(field: SchemaField): Part[] {
  if (field.fields && field.fields.length > 0) {
    const inner = objectInlineParts(field.fields);
    return field.type.endsWith("[]") ? [...inner, ["[]", "operator"]] : inner;
  }
  return [[field.type, "typeKeyword"]];
}

function partsLen(parts: Part[]): number {
  return parts.reduce((n, [t]) => n + cpLen(t), 0);
}

function schemaMultiline(schema: SchemaMeta, indent: number): Line[] {
  if (schema.fields.length === 0 && schema.rootType !== "object") {
    return [row([pad(indent), "plain"], [schema.rootType, "typeKeyword"])];
  }
  return objectMultiline(schema.fields, indent);
}

function objectMultiline(
  fields: readonly SchemaField[],
  indent: number,
): Line[] {
  const lines: Line[] = [row([pad(indent), "plain"], ["{", "bracket"])];
  for (const f of fields) lines.push(...fieldMultiline(f, indent + 1));
  lines.push(row([pad(indent), "plain"], ["}", "bracket"]));
  return lines;
}

function fieldMultiline(field: SchemaField, indent: number): Line[] {
  const head: Part[] = [
    [pad(indent), "plain"],
    [field.name, "schemaKey"],
    [field.required ? "" : "?", "comment"],
    [": ", "punctuation"],
  ];
  if (field.fields && field.fields.length > 0) {
    const inline = fieldTypeInlineParts(field);
    if (partsLen([...head, ...inline]) <= INLINE_MAX) {
      return [row(...head, ...inline)];
    }
    const open = row(...head, ["{", "bracket"]);
    const body = field.fields.flatMap((c) => fieldMultiline(c, indent + 1));
    const close = row(
      [pad(indent), "plain"],
      [field.type.endsWith("[]") ? "}[]" : "}", "bracket"],
    );
    return [open, ...body, close];
  }
  return [row(...head, [field.type, "typeKeyword"])];
}

function pad(indent: number): string {
  return "  ".repeat(indent);
}

// --- line/span helpers -------------------------------------------------------

type Part = readonly [string, TokenClass];

const BLANK: Line = { text: "", spans: [] };

function row(...parts: Part[]): Line {
  let col = 0;
  let text = "";
  const spans: Span[] = [];
  for (const [t, cls] of parts) {
    if (t.length === 0) continue;
    spans.push({ col, text: t, cls });
    col += cpLen(t); // columns are code points, so non-BMP glyphs are 1 wide
    text += t;
  }
  return { text, spans };
}

function heading(text: string): Line {
  return row([text.toUpperCase(), "sectionHeader"]);
}

function crumbLabel(node: StructureNode): string {
  if (node.kind === "section") {
    const base = node.label.replace(/^▸\s*/, "");
    const tail = base.split("/").pop() ?? base;
    return tail.length > 0 ? tail : base;
  }
  return node.label;
}

function trimContext(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 56 ? `${trimmed.slice(0, 55)}…` : trimmed;
}

function glyph(kind: StructureNode["kind"]): string {
  switch (kind) {
    case "section":
      return "▸";
    case "pattern":
      return "◆";
    case "builder":
      return "◇";
    case "closure":
      return "λ";
    case "schema":
      return "▦";
    case "function":
    case "method":
      return "ƒ";
    case "interface":
    case "typeAlias":
    case "class":
      return "𝑻";
    case "import":
      return "⇤";
    case "return":
      return "⏎";
    case "control":
      return "⎇";
    case "hunk":
      return "±";
    default:
      return "·";
  }
}
