import ts from "typescript";
import type {
  CapabilitySummaryRegistry,
  FunctionCapabilitySummary,
  SchemaHint,
  SchemaHints,
  SyntheticReactiveCollectionRegistry,
  TypeRegistry,
} from "./transformers.ts";

/**
 * CrossStageState — the single owner of the pipeline's cross-transformer
 * communication registries.
 *
 * Replaces the formerly-separate registry fields on `TransformationOptions`.
 * Each registry is keyed by AST node or symbol identity, preserved across
 * `ts.transform()` stages. See `core/mod.ts` for the per-registry contract.
 *
 * Division of responsibility with `TransformationContext`:
 *   - CrossStageState owns the DATA (the WeakMaps/WeakSets) and exposes pure
 *     data operations (record/lookup/mark/is). It performs NO cache
 *     invalidation — it has no knowledge of the context's analysis caches.
 *   - TransformationContext keeps the public mark/record methods. For the
 *     four marker-set mutators it delegates to CrossStageState AND then calls
 *     its own `invalidateReactiveAnalysisCaches()`. Invalidation stays a
 *     context concern; this object stays a pure data holder. (This is why the
 *     `mark*` methods here do not invalidate — the context wrapper does.)
 *
 * The raw maps are also exposed as readonly properties because the heavily
 * used `typeRegistry` and the cross-package `schemaHints` are read directly by
 * many call sites (and by the separate schema-generator package, which is not
 * a transformer stage and must not depend on this type — it receives the bare
 * map). Those two are the documented package boundary.
 */
export class CrossStageState {
  readonly typeRegistry: TypeRegistry = new WeakMap();
  readonly mapCallbackRegistry = new WeakSet<ts.Node>();
  readonly syntheticComputeCallbackRegistry = new WeakSet<ts.Node>();
  readonly syntheticComputeOwnedNodeRegistry = new WeakSet<ts.Node>();
  readonly syntheticReactiveCollectionRegistry:
    SyntheticReactiveCollectionRegistry = new WeakSet();
  readonly schemaHints: SchemaHints = new WeakMap();
  readonly capabilitySummaryRegistry: CapabilitySummaryRegistry = new WeakMap();
  readonly narrowedWrapperTypeRegistry = new WeakMap<ts.TypeNode, ts.Type>();

  // --- mapCallbackRegistry ---

  markArrayMethodCallback(node: ts.Node): void {
    this.mapCallbackRegistry.add(node);
  }

  isArrayMethodCallback(node: ts.Node): boolean {
    return this.#hasWithOriginal(this.mapCallbackRegistry, node);
  }

  // --- syntheticComputeCallbackRegistry ---

  markSyntheticComputeCallback(node: ts.Node): void {
    this.syntheticComputeCallbackRegistry.add(node);
  }

  isSyntheticComputeCallback(node: ts.Node): boolean {
    return this.#hasWithOriginal(this.syntheticComputeCallbackRegistry, node);
  }

  // --- syntheticComputeOwnedNodeRegistry ---

  markSyntheticComputeOwnedSubtree(node: ts.Node): void {
    const registry = this.syntheticComputeOwnedNodeRegistry;
    const visit = (current: ts.Node): void => {
      registry.add(current);
      ts.forEachChild(current, visit);
    };
    visit(node);
  }

  isSyntheticComputeOwnedNode(node: ts.Node): boolean {
    return this.#hasWithOriginal(this.syntheticComputeOwnedNodeRegistry, node);
  }

  // --- syntheticReactiveCollectionRegistry (keyed by ts.Symbol) ---

  markSyntheticReactiveCollection(symbol: ts.Symbol): void {
    this.syntheticReactiveCollectionRegistry.add(symbol);
  }

  isSyntheticReactiveCollection(symbol: ts.Symbol): boolean {
    return this.syntheticReactiveCollectionRegistry.has(symbol);
  }

  // --- schemaHints ---

  recordSchemaHint(node: ts.Node, hint: SchemaHint): void {
    this.schemaHints.set(node, hint);
    const original = ts.getOriginalNode(node);
    if (original !== node) {
      this.schemaHints.set(original, hint);
    }
  }

  lookupSchemaHint(node: ts.Node): SchemaHint | undefined {
    return this.schemaHints.get(node) ??
      this.schemaHints.get(ts.getOriginalNode(node));
  }

  // --- capabilitySummaryRegistry ---

  recordCapabilitySummary(
    fn: ts.Node,
    summary: FunctionCapabilitySummary,
  ): void {
    this.capabilitySummaryRegistry.set(fn, summary);
  }

  lookupCapabilitySummary(fn: ts.Node): FunctionCapabilitySummary | undefined {
    return this.capabilitySummaryRegistry.get(fn);
  }

  // --- narrowedWrapperTypeRegistry ---

  markNarrowedWrapper(wrapperNode: ts.TypeNode, preShrinkType: ts.Type): void {
    if (!this.narrowedWrapperTypeRegistry.has(wrapperNode)) {
      this.narrowedWrapperTypeRegistry.set(wrapperNode, preShrinkType);
    }
  }

  lookupNarrowedWrapper(wrapperNode: ts.TypeNode): ts.Type | undefined {
    return this.narrowedWrapperTypeRegistry.get(wrapperNode);
  }

  // --- shared helper: membership check with getOriginalNode fallback ---

  #hasWithOriginal(set: WeakSet<ts.Node>, node: ts.Node): boolean {
    if (set.has(node)) return true;
    const original = ts.getOriginalNode(node);
    return original !== node && set.has(original);
  }
}
