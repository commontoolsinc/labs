/**
 * The builder → ROG front-end (D-V2-SEQ / D-V2-ROG-SIDETABLE).
 *
 * Called once from `factoryFromPattern` at pattern FINALIZATION, with the
 * builder's LIVE objects: the ordered NodeRef list (live modules, live
 * input/output cells), the live result tree, and the same cell-classification
 * helpers the legacy serializer uses. Because everything is live, mapping is
 * direct — `ifElse` hands us its tagged branches, `str` its static template,
 * builtin refs classify by NAME — v1's extract.ts shape-recognition has no
 * counterpart here.
 *
 * The result attaches to the pattern factory via a WeakMap side-table
 * (identity-neutral: nothing is added to the serialized pattern JSON). A
 * pattern loaded as plain JSON without a live factory simply has no ROG and
 * takes the legacy path.
 *
 * FAIL-CLOSED: any shape this front-end cannot represent marks the ROG
 * `incomplete` with a census reason; flag-on dispatch (W3) must fall back to
 * legacy for incomplete ROGs. Construction never throws into the builder —
 * a crash records a census error and yields no ROG.
 */

import { isPlainObject, isRecord } from "@commonfabric/utils/types";
import type {
  ICell,
  JSONSchema,
  JSONValue,
  NodeRef,
  OpaqueCell,
  Reactive,
} from "../builder/types.ts";
import { isCell } from "../cell.ts";
import { DEFAULT_CELL_SCOPE } from "../scope.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { resolveOriginal } from "../builder/pattern-metadata.ts";
import { isStrInterpolation } from "./builtin-markers.ts";
import { computeLeafCaps } from "./leaf-caps.ts";
import {
  type InternalDecl,
  type Op,
  type OpId,
  type Rog,
  ROG_VERSION,
  type SchemaHandle,
  type ValueRef,
} from "./rog.ts";

/** A constructed ROG plus its live side-car state (never serialized). */
export interface BuiltRog {
  rog: Rog;
  /** Live leaf implementations by op id. Captured at construction, so the
   * interpreter needs no `$implRef`/SES resolution on this path — the same
   * functions legacy node instantiation would run. */
  leafImpls: Map<OpId, (input: unknown) => unknown>;
  /** Inlined nested patterns' own BuiltRogs by `pattern` op id (recursive:
   * carries the child's live leaf impls alongside the child Rog the op's
   * detail also references). */
  children: Map<OpId, BuiltRog>;
  /** Each leaf module's declared argumentSchema (when present) — the
   * dispatch binds fully-external leaf inputs through it so schema-driven
   * read semantics (defaults, validation) match legacy's
   * readJavaScriptArgument. */
  leafArgSchemas: Map<OpId, unknown>;
  /** Live element pattern factories for collection ops (op id → factory),
   * so W4 can resolve the element's own BuiltRog at dispatch time. */
  collectionElements: Map<OpId, unknown>;
  /** The CANONICAL's serialized node input/output alias skeletons, by op id
   * (= node index). Used ONLY by the dispatch's derived-copy validation
   * (validatePositionalCorrespondence): a copy may bind against this ROG
   * only if its own serialized nodes carry the SAME alias TARGETS
   * position-for-position (modulo the two lossless copy transforms: defer
   * nesting bumps and scope folded into schema). Never read on the hot
   * path; captured because `getBuiltRogResolved` returns the BuiltRog, not
   * the canonical Pattern. */
  canonicalNodes: ReadonlyArray<{ inputs: unknown; outputs: unknown }>;
}

// --- side-table ------------------------------------------------------------

const rogByPattern = new WeakMap<object, BuiltRog>();

export function setBuiltRog(patternOrFactory: unknown, built: BuiltRog): void {
  if (
    (typeof patternOrFactory === "object" ||
      typeof patternOrFactory === "function") && patternOrFactory !== null
  ) {
    rogByPattern.set(patternOrFactory as object, built);
  }
}

/**
 * STRICT lookup (direct WeakMap keys only). The dispatch MUST use this for
 * the top-level pattern: the ROG's op ids correspond POSITIONALLY to
 * `pattern.nodes`, which holds only for the original factory/pattern objects
 * the builder keyed — a derived COPY (a deserialized stored graph resolving
 * to its live canonical) has its own nodes array and binding against the
 * canonical's ROG would emit garbage.
 */
export function getBuiltRog(patternOrFactory: unknown): BuiltRog | undefined {
  if (
    (typeof patternOrFactory === "object" ||
      typeof patternOrFactory === "function") && patternOrFactory !== null
  ) {
    return rogByPattern.get(patternOrFactory as object);
  }
  return undefined;
}

/**
 * Derivation-aware lookup, for STANDALONE evaluation only (the collection
 * ELEMENT case: the element ROG evaluates against {element,index,params},
 * never indexed against the copy's nodes). Build-time copies of a pattern
 * (traverse-utils clones the factory into a structural Pattern object when
 * it rides a node's input tree — the `op` of mapWithPattern) register with
 * noteDerivedCopy; resolve the chain back to the original the side-table
 * keyed.
 */
export function getBuiltRogResolved(
  patternOrFactory: unknown,
): BuiltRog | undefined {
  const direct = getBuiltRog(patternOrFactory);
  if (direct) return direct;
  if (
    (typeof patternOrFactory === "object" ||
      typeof patternOrFactory === "function") && patternOrFactory !== null
  ) {
    const original = resolveOriginal(patternOrFactory);
    if (original !== patternOrFactory && original !== null) {
      return rogByPattern.get(original as object);
    }
  }
  return undefined;
}

// --- construction census ----------------------------------------------------

export interface RogConstructionCensus {
  patterns: number;
  complete: number;
  incomplete: number;
  buildErrors: number;
  opsByKind: Record<string, number>;
  incompleteReasons: Record<string, number>;
}

const census: RogConstructionCensus = {
  patterns: 0,
  complete: 0,
  incomplete: 0,
  buildErrors: 0,
  opsByKind: {},
  incompleteReasons: {},
};

export function getRogConstructionCensus(): RogConstructionCensus {
  return census;
}

export function resetRogConstructionCensus(): void {
  census.patterns = 0;
  census.complete = 0;
  census.incomplete = 0;
  census.buildErrors = 0;
  census.opsByKind = {};
  census.incompleteReasons = {};
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

// --- construction ------------------------------------------------------------

/** Builtin ref names that are collection coordinators. */
const COLLECTION_REFS = new Set(["map", "filter", "flatMap"]);
/** Builtin ref names that are control ops (tagged emission below). */
const CONTROL_REFS = new Set(["ifElse", "when", "unless"]);

/** The context `factoryFromPattern` hands over — all live. */
export interface RogBuildInput {
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  /** Graph-walk-ordered nodes (same order legacy serialization uses). */
  nodes: NodeRef[];
  /** The live result tree (post collectCellsAndNodes: refs are ICells). */
  outputs: unknown;
  /** "argument" / "result" / undefined classification by root cell. */
  cellNameForCell: (
    cell: ICell<unknown> | OpaqueCell<unknown> | Reactive<unknown>,
  ) => "argument" | "result" | undefined;
  /** Internal roots → their assigned partial causes (legacy naming scheme). */
  internalCauses: Map<OpaqueCell<unknown>, JSONValue>;
  /** The just-computed SERIALIZED nodes (same order as `nodes`) — captured
   * into BuiltRog.canonicalNodes for the derived-copy alias validation. */
  serializedNodes: ReadonlyArray<{ inputs: unknown; outputs: unknown }>;
}

/** Build the ROG for one finalized pattern. Returns undefined on internal
 * error (census `buildErrors`); otherwise always returns a ROG, possibly
 * marked `incomplete` (fail-closed). */
export function tryBuildRogFromBuilder(
  input: RogBuildInput,
): BuiltRog | undefined {
  census.patterns++;
  try {
    const built = buildRog(input);
    if (built.rog.incomplete?.length) {
      census.incomplete++;
      for (const r of built.rog.incomplete) {
        bump(census.incompleteReasons, r.split(":")[0]);
      }
    } else {
      census.complete++;
    }
    for (const op of built.rog.ops) bump(census.opsByKind, op.kind);
    return built;
  } catch (e) {
    census.buildErrors++;
    bump(
      census.incompleteReasons,
      `build_threw:${e instanceof Error ? e.name : "unknown"}`,
    );
    return undefined;
  }
}

function buildRog(input: RogBuildInput): BuiltRog {
  const { nodes, cellNameForCell, internalCauses } = input;
  const incomplete: string[] = [];
  const leafImpls = new Map<OpId, (input: unknown) => unknown>();
  const children = new Map<OpId, BuiltRog>();
  const collectionElements = new Map<OpId, unknown>();
  const leafArgSchemas = new Map<OpId, unknown>();

  // Pass 1 — reserve op ids for nodes; map output roots to producers.
  const ops: (Op | null)[] = nodes.map(() => null);
  const opIdByNode = new Map<NodeRef, OpId>();
  const outputRootToOp = new Map<object, OpId>();
  nodes.forEach((node, i) => {
    opIdByNode.set(node, i);
    const outCell = asCell(node.outputs);
    if (outCell) {
      const top = outCell.export().cell as unknown as object;
      // Fresh reactive per factory call ⇒ roots are unique; first-wins is a
      // guard, not an expected path.
      if (!outputRootToOp.has(top)) outputRootToOp.set(top, i);
    }
  });

  // Internals table (D-V2-INTERNALS-TABLE): index per internal root.
  const internals: InternalDecl[] = [];
  const internalIdxByRoot = new Map<object, number>();
  const externals: unknown[] = [];
  const externalIdxByRoot = new Map<object, number>();
  for (const [root, partialCause] of internalCauses) {
    const idx = internals.length;
    internalIdxByRoot.set(root as unknown as object, idx);
    const producedBy = outputRootToOp.get(root as unknown as object);
    const schema = (root as unknown as ICell<unknown>).export?.()?.schema as
      | SchemaHandle
      | undefined;
    internals.push({
      partialCause: partialCause as unknown,
      ...(schema !== undefined && { schema }),
      ...(producedBy !== undefined && { producedBy }),
    });
  }

  const appendOp = (op: Omit<Op, "id">): OpId => {
    const id = ops.length;
    ops.push({ ...op, id });
    return id;
  };

  // --- value-space mapping ---------------------------------------------------

  const refForCell = (cell: ICell<unknown>): ValueRef | undefined => {
    const exported = cell.export();
    const { path, external, scope } = exported;
    const top = exported.cell as unknown as object;
    if (external) {
      // Externally-identified cell: store its serialized reference (exactly
      // what legacy toJSONWithLegacyAliases writes) and read it by index.
      let idx = externalIdxByRoot.get(top);
      if (idx === undefined) {
        idx = externals.length;
        externalIdxByRoot.set(top, idx);
        externals.push(external);
      }
      return {
        kind: "external",
        cell: idx,
        path: (path as readonly PropertyKey[]).map((p) => String(p)),
      };
    }
    if (scope !== undefined && scope !== DEFAULT_CELL_SCOPE) {
      // Narrowed scopes (user/session) stay legacy for now (v1
      // D-EMISSION-SCOPE parity: deliberate boundary, not a gap). The
      // default "space" scope is every ordinary cell — not a narrowing.
      incomplete.push(`scoped_cell:${String(scope)}`);
      return undefined;
    }
    const stringPath = (path as readonly PropertyKey[]).map((p) => String(p));
    const name = cellNameForCell(cell);
    if (name === "argument") return { kind: "argument", path: stringPath };
    if (name === "result") return { kind: "result", path: stringPath };
    const producer = outputRootToOp.get(top);
    if (producer !== undefined) {
      return { kind: "opOut", op: producer, path: stringPath };
    }
    const internalIdx = internalIdxByRoot.get(top);
    if (internalIdx !== undefined) {
      return { kind: "internal", cell: internalIdx, path: stringPath };
    }
    incomplete.push("unmapped_cell");
    return undefined;
  };

  // Memo so shared subtrees map to one construct op; `building` guards cycles.
  const valueMemo = new Map<object, ValueRef>();
  const building = new Set<object>();

  // Const values must be DOC-NORMALIZATION FIXED POINTS: legacy leaves read
  // statics AFTER a doc round-trip (the JSON data model), while evalRog
  // feeds consts to leaf fns DIRECTLY. Anything the round-trip can change —
  // NaN/±Infinity (JSON → null), Date/Map/Set/RegExp/typed arrays/class
  // instances (preserved by structuredClone, mangled or rejected by the doc
  // model), bigint (JSON throws) — would make the interpreted leaf observe
  // a different input than the legacy leaf. Refuse → the whole pattern runs
  // legacy (fail-closed). `undefined` is a fixed point in effect only as an
  // OBJECT PROPERTY (legacy drops the key; reads see undefined either way);
  // in an ARRAY slot JSON nulls it, so it refuses there.
  const isFixedPointPrimitive = (v: unknown): boolean =>
    v === null || typeof v === "string" || typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v));
  const isPlainJsonData = (v: unknown, depth = 0): boolean => {
    if (depth > 64) return false; // deep or cyclic: refuse
    if (isFixedPointPrimitive(v)) return true;
    if (Array.isArray(v)) {
      // Sparse holes / undefined slots are NOT fixed points ([,] → null).
      for (let i = 0; i < v.length; i++) {
        if (!(i in v) || !isPlainJsonData(v[i], depth + 1)) return false;
      }
      return true;
    }
    // isPlainObject (prototype check), NOT isRecord: a Date/Map/class
    // instance has no own enumerable props, so a key-walk is vacuously
    // "plain" while the value is anything but.
    if (isPlainObject(v)) {
      return Object.values(v as Record<string, unknown>).every((m) =>
        m === undefined || isPlainJsonData(m, depth + 1)
      );
    }
    return false;
  };

  const refForValue = (value: unknown): ValueRef | undefined => {
    if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);
    if (isCell(value)) return refForCell(value as unknown as ICell<unknown>);
    if (value === null || typeof value !== "object") {
      if (typeof value === "function") {
        incomplete.push("function_in_input");
        return undefined;
      }
      if (value !== undefined && !isFixedPointPrimitive(value)) {
        incomplete.push("non_fixed_point_const");
        return undefined;
      }
      return { kind: "const", value };
    }
    const obj = value as object;
    const memoized = valueMemo.get(obj);
    if (memoized) return memoized;
    if (building.has(obj)) {
      incomplete.push("cyclic_value");
      return undefined;
    }
    building.add(obj);
    try {
      if (!containsMappableRef(obj)) {
        // Pure static data — carry a SNAPSHOT (bot finding: legacy
        // serializes pattern inputs, so post-construction mutation of a
        // captured object must not leak into evaluation). Gated to plain
        // JSON fixed points first, so structuredClone below cannot throw
        // and cannot smuggle values the doc model would normalize.
        if (!isPlainJsonData(obj)) {
          incomplete.push("non_fixed_point_const");
          return undefined;
        }
        const ref: ValueRef = { kind: "const", value: structuredClone(obj) };
        valueMemo.set(obj, ref);
        return ref;
      }
      if (Array.isArray(obj)) {
        const items: ValueRef[] = [];
        for (const item of obj) {
          const ref = refForValue(item);
          if (!ref) return undefined;
          items.push(ref);
        }
        const id = appendOp({
          kind: "construct",
          inputs: [],
          outSchema: {},
          detail: { kind: "construct", template: { shape: "array", items } },
        });
        const ref: ValueRef = { kind: "opOut", op: id, path: [] };
        valueMemo.set(obj, ref);
        return ref;
      }
      if (isRecord(obj)) {
        const fields: Record<string, ValueRef> = {};
        for (const [key, item] of Object.entries(obj)) {
          const ref = refForValue(item);
          if (!ref) return undefined;
          fields[key] = ref;
        }
        const id = appendOp({
          kind: "construct",
          inputs: [],
          outSchema: {},
          detail: { kind: "construct", template: { shape: "object", fields } },
        });
        const ref: ValueRef = { kind: "opOut", op: id, path: [] };
        valueMemo.set(obj, ref);
        return ref;
      }
      incomplete.push("unrepresentable_value");
      return undefined;
    } finally {
      building.delete(obj);
    }
  };

  /** Does this subtree contain any cell (or dereferencable) ref? Plain data
   * without refs stays a `const` instead of a construct op. */
  const containsMappableRef = (value: unknown, depth = 0): boolean => {
    if (depth > 64) return true; // deep/cyclic: force the construct path
    if (isCellResultForDereferencing(value) || isCell(value)) return true;
    if (value === null || typeof value !== "object") {
      return typeof value === "function";
    }
    if (Array.isArray(value)) {
      return value.some((v) => containsMappableRef(v, depth + 1));
    }
    if (isRecord(value)) {
      return Object.values(value).some((v) =>
        containsMappableRef(v, depth + 1)
      );
    }
    return true;
  };

  /** Conservative collection of all cell refs in an input tree (handler
   * write-target over-approximation — over-cutting is safe, F4). */
  const collectCellRefs = (value: unknown, into: ValueRef[]): void => {
    if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);
    if (isCell(value)) {
      const ref = refForCell(value as unknown as ICell<unknown>);
      if (ref && ref.kind !== "const") into.push(ref);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) collectCellRefs(v, into);
      return;
    }
    if (isRecord(value)) {
      for (const v of Object.values(value)) collectCellRefs(v, into);
    }
  };

  // --- per-node op emission ----------------------------------------------------

  const inputField = (node: NodeRef, key: string): unknown =>
    isRecord(node.inputs)
      ? (node.inputs as Record<string, unknown>)[key]
      : undefined;

  const emitOpForNode = (node: NodeRef, id: OpId): Op => {
    const outSchema = (moduleOf(node)?.resultSchema ?? {}) as SchemaHandle;
    const mod = moduleOf(node);

    if (!mod) {
      incomplete.push("dynamic_module");
      return boundaryOp(id, outSchema, "io", undefined, node);
    }

    if (mod.type === "pattern") {
      const argument = refForValue(node.inputs) ??
        markIncomplete(id, "pattern_argument_unmapped");
      const childBuilt = getBuiltRog(mod.implementation);
      if (childBuilt !== undefined) children.set(id, childBuilt);
      return {
        id,
        kind: "pattern",
        inputs: [],
        outSchema,
        detail: {
          kind: "pattern",
          argument: argument ?? { kind: "const", value: undefined },
          ...(childBuilt !== undefined && { child: childBuilt.rog }),
        },
      };
    }

    if (mod.type === "ref" && typeof mod.implementation === "string") {
      const name = mod.implementation;
      if (CONTROL_REFS.has(name)) return emitControl(node, id, name, outSchema);
      if (COLLECTION_REFS.has(name)) {
        return emitCollection(node, id, name, outSchema);
      }
      // Every other ref (fetch*/llm*/generate*/sqlite*/compileAndRun/
      // streamData/unknown-future-builtins) is an I/O effect boundary —
      // fail-closed by construction, no allow-list to maintain.
      return boundaryOp(id, outSchema, "io", name, node);
    }

    if (mod.type === "javascript") {
      if (mod.wrapper === "handler") {
        const writeTargets: ValueRef[] = [];
        collectCellRefs(node.inputs, writeTargets);
        const dataInputs = refForValue(node.inputs);
        return {
          id,
          kind: "effect",
          inputs: dataInputs ? [dataInputs] : [],
          outSchema,
          detail: { kind: "effect", sink: "handler", writeTargets },
        };
      }
      if (
        isStrInterpolation(mod.implementation) && isRecord(node.inputs) &&
        Array.isArray((node.inputs as Record<string, unknown>).strings)
      ) {
        const strings = Array.from(
          (node.inputs as Record<string, unknown>).strings as unknown[],
          (s) => String(s),
        );
        const rawValues = (node.inputs as Record<string, unknown>).values;
        const valueRefs: ValueRef[] = [];
        let allResolved = Array.isArray(rawValues);
        if (Array.isArray(rawValues)) {
          for (const v of rawValues) {
            const ref = refForValue(v);
            if (!ref) {
              allResolved = false;
              break;
            }
            valueRefs.push(ref);
          }
        }
        if (allResolved) {
          return {
            id,
            kind: "interpolate",
            inputs: valueRefs,
            outSchema,
            detail: { kind: "interpolate", strings, values: valueRefs },
          };
        }
        // fall through to leaf — the lift body is right there.
      }
      if (typeof mod.implementation === "function") {
        leafImpls.set(id, mod.implementation as (input: unknown) => unknown);
        // Fail-closed capability annotations from the LIVE source + declared
        // schemas (leaf-caps.ts — the v1 static scans at capture time).
        const argumentSchema =
          (mod as { argumentSchema?: unknown }).argumentSchema;
        if (argumentSchema !== undefined && argumentSchema !== false) {
          leafArgSchemas.set(id, argumentSchema);
        }
        const caps = computeLeafCaps(
          mod.implementation,
          argumentSchema,
          mod.resultSchema,
        );
        const detail = {
          kind: "leaf" as const,
          ...(caps && { caps }),
          // Legacy `argumentSchema === false` = run-without-argument bypass.
          ...(argumentSchema === false && { ungated: true as const }),
        };
        const dataInput = refForValue(node.inputs);
        if (!dataInput) {
          // Input not representable: keep the leaf but mark the graph
          // incomplete (dispatch falls back; reason already recorded).
          return { id, kind: "leaf", inputs: [], outSchema, detail };
        }
        return { id, kind: "leaf", inputs: [dataInput], outSchema, detail };
      }
      incomplete.push("javascript_without_function");
      return boundaryOp(id, outSchema, "io", undefined, node);
    }

    incomplete.push(`module_type:${String(mod.type)}`);
    return boundaryOp(id, outSchema, "io", String(mod.type), node);
  };

  const emitControl = (
    node: NodeRef,
    id: OpId,
    name: string,
    outSchema: SchemaHandle,
  ): Op => {
    const pred = refForValue(inputField(node, "condition"));
    if (!pred) return boundaryOp(id, outSchema, "io", name, node);
    if (name === "ifElse") {
      const thenRef = refForValue(inputField(node, "ifTrue"));
      const elseRef = refForValue(inputField(node, "ifFalse"));
      if (!thenRef || !elseRef) {
        return boundaryOp(id, outSchema, "io", name, node);
      }
      return {
        id,
        kind: "control",
        inputs: [],
        outSchema,
        detail: {
          kind: "control",
          op: "ifElse",
          pred,
          then: thenRef,
          else: elseRef,
        },
      };
    }
    // Fully normalized tags (rog.ts control detail): then/else mean exactly
    // "value when pred truthy/falsy"; "pred" = the predicate's own value.
    // when(c, v) = c ? v : c   → { then: v,      else: "pred" }
    // unless(c, f) = c ? c : f → { then: "pred", else: f }
    const valueKey = name === "when" ? "value" : "fallback";
    const valueRef = refForValue(inputField(node, valueKey));
    if (!valueRef) return boundaryOp(id, outSchema, "io", name, node);
    return {
      id,
      kind: "control",
      inputs: [],
      outSchema,
      detail: name === "when"
        ? { kind: "control", op: "when", pred, then: valueRef, else: "pred" }
        : {
          kind: "control",
          op: "unless",
          pred,
          then: "pred",
          else: valueRef,
        },
    };
  };

  const emitCollection = (
    node: NodeRef,
    id: OpId,
    name: string,
    outSchema: SchemaHandle,
  ): Op => {
    const listInput = refForValue(inputField(node, "list"));
    if (!listInput) return boundaryOp(id, outSchema, "io", name, node);
    if (name !== "map" && name !== "filter" && name !== "flatMap") {
      return boundaryOp(id, outSchema, "io", name, node);
    }
    // Capture the params ref when the node declares one: transient
    // (segment-resident) evaluation resolves it in-memory. A declared but
    // unmappable params keeps the node a BOUNDARY (materialized
    // coordinators read params off the node inputs regardless).
    const rawParams = inputField(node, "params");
    const params = rawParams !== undefined ? refForValue(rawParams) : undefined;
    if (rawParams !== undefined && !params) {
      return boundaryOp(id, outSchema, "io", name, node);
    }
    const opFactory = inputField(node, "op");
    const element = getBuiltRog(opFactory)?.rog;
    if (opFactory !== undefined) collectionElements.set(id, opFactory);
    return {
      id,
      kind: "collection",
      inputs: [],
      outSchema,
      detail: {
        kind: "collection",
        op: name,
        listInput,
        ...(params !== undefined && { params }),
        ...(element !== undefined && { element }),
      },
    };
  };

  const boundaryOp = (
    id: OpId,
    outSchema: SchemaHandle,
    sink: "io" | "handler",
    builtin: string | undefined,
    node: NodeRef,
  ): Op => {
    const dataInputs = refForValue(node.inputs);
    return {
      id,
      kind: "effect",
      inputs: dataInputs ? [dataInputs] : [],
      outSchema,
      detail: {
        kind: "effect",
        sink,
        ...(builtin !== undefined && { builtin }),
        writeTargets: [],
      },
    };
  };

  const markIncomplete = (
    _id: OpId,
    reason: string,
  ): undefined => {
    incomplete.push(reason);
    return undefined;
  };

  // Pass 2 — emit ops (constructs append past the reserved range).
  nodes.forEach((node, i) => {
    ops[i] = emitOpForNode(node, i);
  });

  // Result tree → egress root ref.
  const result = refForValue(input.outputs) ??
    (incomplete.push("result_unmapped"),
      { kind: "const", value: undefined } satisfies ValueRef);

  const rog: Rog = {
    v: ROG_VERSION,
    argumentSchema: input.argumentSchema,
    resultSchema: input.resultSchema,
    result,
    ops: ops as Op[],
    internals,
    ...(externals.length > 0 && { externals }),
    ...(incomplete.length > 0 && { incomplete: dedupe(incomplete) }),
  };
  const canonicalNodes = input.serializedNodes.map((n) => ({
    inputs: n.inputs,
    outputs: n.outputs,
  }));
  return {
    rog,
    leafImpls,
    children,
    collectionElements,
    leafArgSchemas,
    canonicalNodes,
  };
}

function dedupe(reasons: string[]): string[] {
  return Array.from(new Set(reasons));
}

function asCell(value: unknown): ICell<unknown> | undefined {
  if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);
  return isCell(value) ? (value as unknown as ICell<unknown>) : undefined;
}

type LiveModule = {
  type?: string;
  implementation?: unknown;
  wrapper?: string;
  resultSchema?: JSONSchema;
};

/** The node's live module, or undefined when the module itself is reactive /
 * dynamic (a `derive`-returned module — a boundary). */
function moduleOf(node: NodeRef): LiveModule | undefined {
  const mod = node.module as unknown;
  if (isCell(mod) || isCellResultForDereferencing(mod)) return undefined;
  if (
    (typeof mod === "object" || typeof mod === "function") && mod !== null &&
    typeof (mod as LiveModule).type === "string"
  ) {
    return mod as LiveModule;
  }
  return undefined;
}
