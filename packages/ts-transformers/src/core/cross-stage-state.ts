import ts from "typescript";
import type {
  FunctionCapabilitySummary,
  SchemaHint,
  SchemaHints,
  SyntheticReactiveCollectionRegistry,
  TypeRegistry,
} from "./transformers.ts";
import type { CfcPolicyCompilerManifestV1 } from "./runtime-contract.ts";

/**
 * Per-node side table, mirroring the TypeScript compiler's internal `NodeLinks`
 * pattern (src/compiler/types.ts): one struct of optional derived facts keyed by
 * node identity, lazily populated. It holds the transformer-internal,
 * non-cache-invalidating channels that are keyed by `ts.Node` and never cross the
 * schema-generator package boundary.
 *
 * Deliberately NOT exported from `core/mod.ts`: the schema-generator package must
 * not depend on this type (it reads only the bare `typeRegistry` / `schemaHints`
 * maps — the published boundary contract). Channels that cross that boundary, or
 * that are coupled to the context's reactive-analysis cache invalidation, stay as
 * their own maps/sets; see the registry doc block in `core/mod.ts`.
 */
export interface NodeTypeLinks {
  /** Cached per-function capability summary (was `capabilitySummaryRegistry`). */
  capabilitySummary?: FunctionCapabilitySummary;
  /**
   * Whether SchemaInjection has finalized this builder call/new node (was
   * `schemaInjectedRegistry`). A bare presence flag with NO getOriginalNode
   * fallback — it tags synthetic nodes we produce, whose original is the
   * pre-injection user call, which must NOT read as injected.
   */
  schemaInjected?: true;
}

/**
 * CrossStageState — the single owner of the pipeline's cross-transformer
 * communication registries.
 *
 * Replaces the formerly-separate registry fields on `TransformationOptions`.
 * Each registry is keyed by AST node or symbol identity, preserved across
 * `ts.transform()` stages. See `core/mod.ts` for the per-registry contract.
 *
 * Storage is organized into three families (see `core/mod.ts` for the full
 * rationale):
 *   1. Bare cross-package maps — `typeRegistry`, `schemaHints`. The published
 *      boundary contract: the separate schema-generator package reads them
 *      directly as plain WeakMaps and must not depend on this class or on
 *      `NodeTypeLinks`. They stay their own maps deliberately (mirrors how the
 *      TS compiler keeps `NodeLinks` private and exposes narrow accessors).
 *   2. `nodeLinks` — the NodeLinks-shaped side table for the internal,
 *      non-cache-invalidating per-node channels (capabilitySummary,
 *      schemaInjected), reached only through the record/lookup/mark/is methods.
 *   3. The marker family — node/symbol-keyed WeakSets. Reactive-analysis
 *      marker mutators are coupled to context cache invalidation; late
 *      emission markers such as live factory derivations are not.
 *
 * Division of responsibility with `TransformationContext`:
 *   - CrossStageState owns the DATA and exposes pure data operations
 *     (record/lookup/mark/is). It performs NO cache invalidation — it has no
 *     knowledge of the context's analysis caches.
 *   - TransformationContext keeps the public mark/record methods. For the
 *     four reactive marker-set mutators it delegates to CrossStageState AND then calls
 *     its own `invalidateReactiveAnalysisCaches()`. Invalidation stays a
 *     context concern; this object stays a pure data holder. (This is why the
 *     `mark*` methods here do not invalidate — the context wrapper does.)
 */
export class CrossStageState {
  readonly #policyManifests = new Map<
    string,
    readonly CfcPolicyCompilerManifestV1[]
  >();

  recordPolicyManifests(
    fileName: string,
    manifests: readonly CfcPolicyCompilerManifestV1[],
  ): void {
    this.#policyManifests.set(fileName, manifests);
  }

  getPolicyManifests(): ReadonlyMap<
    string,
    readonly CfcPolicyCompilerManifestV1[]
  > {
    return this.#policyManifests;
  }
  /**
   * Bare cross-package channels (the published boundary contract). Read
   * directly by the schema-generator package as plain WeakMaps; they must NOT
   * be folded into `nodeLinks`. See `core/mod.ts`.
   */
  readonly typeRegistry: TypeRegistry = new WeakMap();
  readonly schemaHints: SchemaHints = new WeakMap();

  /**
   * NodeLinks-shaped side table for the transformer-internal,
   * non-cache-invalidating per-node channels (capabilitySummary, schemaInjected).
   */
  readonly nodeLinks = new WeakMap<ts.Node, NodeTypeLinks>();

  /**
   * Source-position keys already emitted by `reportDiagnosticOnce`, so a
   * diagnostic about a value that more than one stage walks (e.g. the inner-lift
   * revisit) is emitted a single time.
   */
  readonly #reportedDiagnosticKeys = new Set<string>();

  /** Marker family — keyed by node/symbol identity; cache-coupled via context. */
  readonly mapCallbackRegistry = new WeakSet<ts.Node>();
  readonly syntheticComputeCallbackRegistry = new WeakSet<ts.Node>();
  readonly syntheticComputeOwnedNodeRegistry = new WeakSet<ts.Node>();
  readonly liveFactoryDerivationRegistry = new WeakSet<ts.Node>();
  readonly syntheticReactiveCollectionRegistry:
    SyntheticReactiveCollectionRegistry = new WeakSet();

  /** Get-or-create the links entry for a node (lazy, like getNodeLinks). */
  #linksFor(node: ts.Node): NodeTypeLinks {
    let links = this.nodeLinks.get(node);
    if (!links) {
      links = {};
      this.nodeLinks.set(node, links);
    }
    return links;
  }

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

  // --- liveFactoryDerivationRegistry ---

  markLiveFactoryDerivation(node: ts.Node): void {
    this.liveFactoryDerivationRegistry.add(node);
  }

  isLiveFactoryDerivation(node: ts.Node): boolean {
    return this.#hasWithOriginal(this.liveFactoryDerivationRegistry, node);
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
    this.schemaHints.set(node, {
      ...this.schemaHints.get(node),
      ...hint,
    });
    const original = ts.getOriginalNode(node);
    if (original !== node) {
      this.schemaHints.set(original, {
        ...this.schemaHints.get(original),
        ...hint,
      });
    }
  }

  lookupSchemaHint(node: ts.Node): SchemaHint | undefined {
    return this.schemaHints.get(node) ??
      this.schemaHints.get(ts.getOriginalNode(node));
  }

  // --- capabilitySummary (nodeLinks-backed) ---

  recordCapabilitySummary(
    fn: ts.Node,
    summary: FunctionCapabilitySummary,
  ): void {
    this.#linksFor(fn).capabilitySummary = summary;
  }

  lookupCapabilitySummary(fn: ts.Node): FunctionCapabilitySummary | undefined {
    return this.nodeLinks.get(fn)?.capabilitySummary;
  }

  // --- schemaInjected (nodeLinks-backed) ---
  //
  // Marks builder call/new nodes that SchemaInjection has already finalized,
  // so a later re-traversal of the transformer's own output skips re-injection
  // instead of re-deriving "already injected?" from argument count. Replaces
  // the scattered arg-count idempotency guards (e.g. `args.length >= 5`).
  //
  // Uses a plain presence check with NO `getOriginalNode` fallback: it tags
  // SYNTHETIC nodes WE produced, whose original (if any) is the *pre-injection*
  // user call. Falling back to the original would wrongly report a
  // not-yet-injected user node as injected. (This is why it is a `nodeLinks`
  // field rather than a member of the getOriginalNode-fallback marker family.)

  markSchemaInjected(node: ts.Node): void {
    this.#linksFor(node).schemaInjected = true;
  }

  isSchemaInjected(node: ts.Node): boolean {
    // Plain presence check with NO getOriginalNode fallback (see field doc).
    return this.nodeLinks.get(node)?.schemaInjected === true;
  }

  // --- diagnostic dedup ---

  /**
   * Records that a diagnostic with `key` is being emitted. Returns true the
   * first time a key is seen and false thereafter, so callers can suppress
   * duplicates of the same diagnostic across stages.
   */
  markDiagnosticReported(key: string): boolean {
    if (this.#reportedDiagnosticKeys.has(key)) {
      return false;
    }
    this.#reportedDiagnosticKeys.add(key);
    return true;
  }

  // --- shared helper: membership check with getOriginalNode fallback ---

  #hasWithOriginal(set: WeakSet<ts.Node>, node: ts.Node): boolean {
    if (set.has(node)) return true;
    const original = ts.getOriginalNode(node);
    return original !== node && set.has(original);
  }
}
