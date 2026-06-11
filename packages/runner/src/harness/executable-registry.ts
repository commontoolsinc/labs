import { hardenVerifiedFunction } from "../sandbox/function-hardening.ts";
import type { UnsafeHostTrustOptions } from "../unsafe-host-trust.ts";
import type { HarnessedFunction } from "./types.ts";

interface AssociatedFunction {
  implementationRef: string;
  implementation: HarnessedFunction;
}

/**
 * The engine's executable store. Two concerns remain after the
 * content-addressed identity migration (PR E2 of
 * docs/specs/content-addressed-action-identity-implementation-plan.md deleted
 * the per-load partitions, the loadId mappings, and the binding-metadata map
 * — CFC identity now flows exclusively through the provenance side tables in
 * harness/verified-provenance.ts):
 *
 * 1. The content-addressed implementation index (`{identity, symbol}` → fn) —
 *    the resolution backing for serialized `$implRef`s.
 * 2. The legacy string-keyed executable index (`implementationRef` → fn) —
 *    the RETAINED read path (gate-2 decision) for graphs persisted before the
 *    writer flip, plus the two categories `$implRef` cannot cover:
 *    host-trusted values and dynamic in-action-created artifacts.
 */
export class ExecutableRegistry {
  // Legacy global executable index: minted content-derived ref → the live
  // verified function. Populated by the builder's ambient registrar during
  // verified evaluation (`ensureImplementationRef` →
  // `registerVerifiedFunctionImplementation`) and by the runner's in-action
  // registrar for dynamic artifacts. Strong and session-unbounded — this is
  // what keeps a pre-flip stored graph (`implementationRef`, body omitted)
  // resolvable after its module re-evaluates, independent of any bounded
  // cache. Retires with the legacy read path (design Phase 4).
  private readonly verifiedFunctionIndex = new Map<string, HarnessedFunction>();
  private readonly trustedHostFunctionIndex = new Map<
    string,
    HarnessedFunction
  >();
  private trustedHostFunctionRefs = new WeakMap<HarnessedFunction, string>();
  private nextTrustedHostFunctionId = 0;
  // Content-addressed implementation index: module identity → symbol → the
  // implementation function recorded by `Engine.recordModuleProvenance` during
  // a verified evaluation. Deliberately STRONG and session-unbounded, like the
  // legacy `verifiedFunctionIndex` whose eviction insurance it replaces: the
  // bounded artifact index (`PatternManager.addressableByIdentity`, FIFO 1000)
  // can roll a running pattern's module out mid-session, and a post-flip
  // serialized graph carries ONLY `$implRef` — no legacy ref, and no body when
  // the writer proved this index admits the ref. Retention is bounded by the
  // set of DISTINCT verified implementations evaluated this session.
  private readonly verifiedImplementationsByEntryRef = new Map<
    string,
    Map<string, HarnessedFunction>
  >();

  clear(): void {
    this.verifiedFunctionIndex.clear();
    this.trustedHostFunctionIndex.clear();
    this.trustedHostFunctionRefs = new WeakMap();
    this.nextTrustedHostFunctionId = 0;
    this.verifiedImplementationsByEntryRef.clear();
  }

  /**
   * Record a verified implementation under its content-addressed
   * `{ identity, symbol }` entry ref. Overwrites: a re-evaluation of the same
   * identity resolves to the fresh function (mirroring the artifact index;
   * any two instances of one module identity are interchangeable — the SES
   * verifier forbids module-scope mutable state).
   */
  registerVerifiedImplementation(
    identity: string,
    symbol: string,
    implementation: HarnessedFunction,
  ): void {
    let bucket = this.verifiedImplementationsByEntryRef.get(identity);
    if (!bucket) {
      bucket = new Map();
      this.verifiedImplementationsByEntryRef.set(identity, bucket);
    }
    bucket.set(symbol, implementation);
  }

  getVerifiedImplementation(
    identity: string,
    symbol: string,
  ): HarnessedFunction | undefined {
    return this.verifiedImplementationsByEntryRef.get(identity)?.get(symbol);
  }

  /**
   * Admit a verified function into the global executable index under its
   * minted content-derived ref. Called for every builder artifact minted
   * during a verified evaluation (via the ambient registrar) and for dynamic
   * in-action-created artifacts (via the runner's registrar). Overwrites: a
   * later mint of the same content-derived ref points the index at the fresh
   * function, and any two functions sharing a ref are interchangeable by
   * construction (the ref folds in source and preview).
   */
  registerVerifiedFunction(
    implementationRef: string,
    implementation: HarnessedFunction,
  ): void {
    this.verifiedFunctionIndex.set(implementationRef, implementation);
  }

  getVerifiedFunction(
    implementationRef: string,
  ): HarnessedFunction | undefined {
    // Single global index: under content addressing any live instance of the
    // same module is interchangeable (the SES verifier forbids module-scope
    // mutable state, so two evaluations of one module identity differ only in
    // object identity — never behavior).
    return this.verifiedFunctionIndex.get(implementationRef);
  }

  getExecutableFunction(
    implementationRef: string,
  ): HarnessedFunction | undefined {
    return this.getVerifiedFunction(implementationRef) ??
      this.trustedHostFunctionIndex.get(implementationRef);
  }

  trustHostValue(
    value: unknown,
    options: UnsafeHostTrustOptions,
  ): void {
    if (
      typeof options.reason !== "string" || options.reason.trim().length === 0
    ) {
      throw new Error("unsafe host trust requires a non-empty reason");
    }
    const registry = new Map<string, HarnessedFunction>();
    this.collectAssociatedFunctions(value, registry, new Set(), true);
    for (const [implementationRef, implementation] of registry) {
      this.trustedHostFunctionIndex.set(implementationRef, implementation);
    }
  }

  private collectAssociatedFunctions(
    value: unknown,
    registry: Map<string, HarnessedFunction>,
    seen: Set<unknown>,
    allowMintMissingRefs = false,
  ): void {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    const associated = this.extractAssociatedFunction(
      value,
      allowMintMissingRefs,
    );
    if (associated) {
      registry.set(associated.implementationRef, associated.implementation);
    }

    for (const child of verifiedWalkChildValues(value as object)) {
      this.collectAssociatedFunctions(
        child,
        registry,
        seen,
        allowMintMissingRefs,
      );
    }
  }

  private extractAssociatedFunction(
    value: unknown,
    allowMintMissingRefs = false,
  ): AssociatedFunction | null {
    const record = value as {
      implementationRef?: string;
      implementation?: unknown;
    };
    if (typeof record.implementation === "function") {
      const implementation = record.implementation as HarnessedFunction;
      const implementationRef = typeof record.implementationRef === "string"
        ? record.implementationRef
        : allowMintMissingRefs
        ? this.ensureTrustedHostImplementationRef(implementation)
        : undefined;
      if (!implementationRef) {
        return null;
      }
      record.implementationRef ??= implementationRef;
      return {
        implementationRef,
        implementation,
      };
    }
    if (typeof value === "function") {
      const implementation = value as HarnessedFunction;
      const implementationRef = allowMintMissingRefs
        ? this.ensureTrustedHostImplementationRef(implementation)
        : (value as { implementationRef?: string }).implementationRef;
      return implementationRef
        ? {
          implementationRef,
          implementation,
        }
        : null;
    }
    // A ref-only record (no live implementation) carries nothing executable.
    // The lookup that used to rebind such refs went away with the deleted
    // pattern-scoped registries (#4013).
    return null;
  }

  private ensureTrustedHostImplementationRef(
    implementation: HarnessedFunction,
  ): string {
    const existing = this.trustedHostFunctionRefs.get(implementation) ??
      (typeof (implementation as { implementationRef?: string })
          .implementationRef ===
          "string"
        ? (implementation as { implementationRef?: string }).implementationRef
        : undefined);
    if (existing) {
      hardenVerifiedFunction(implementation as (...args: any[]) => unknown);
      return existing;
    }

    const implementationRef = `unsafe-host:${this.nextTrustedHostFunctionId++}`;
    this.trustedHostFunctionRefs.set(implementation, implementationRef);
    if (
      Object.isExtensible(implementation) &&
      typeof (implementation as { implementationRef?: string })
          .implementationRef !==
        "string"
    ) {
      Object.defineProperty(implementation, "implementationRef", {
        value: implementationRef,
        configurable: true,
      });
    }
    hardenVerifiedFunction(implementation as (...args: any[]) => unknown);
    return implementationRef;
  }
}

/**
 * Yield the child values to recurse into when walking a verified value graph
 * (used by {@link ExecutableRegistry.trustHostValue}'s
 * `collectAssociatedFunctions`).
 *
 * Data properties — the AMD/CommonJS bundle shape (`exports.x = …`) — expose
 * their value directly. SES module-namespace exports — the ESM module-record
 * loader shape — are live-binding ACCESSOR properties (`get`/`set`, no `value`).
 * Reading only `descriptor.value` therefore never descends into an ESM module's
 * exports (CT-1623).
 *
 * Reading via [[Get]] is scoped to genuine module namespaces (see
 * {@link isModuleNamespaceObject}), whose getters are spec-defined live bindings
 * with no user-controlled side effects. Getters on ordinary objects are
 * deliberately NOT invoked, preserving the side-effect-free walk over data
 * values.
 */
export function* verifiedWalkChildValues(value: object): Generator<unknown> {
  const isModuleNamespace = isModuleNamespaceObject(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      continue;
    }
    if ("value" in descriptor) {
      yield descriptor.value;
    } else if (isModuleNamespace && typeof descriptor.get === "function") {
      try {
        yield (value as Record<PropertyKey, unknown>)[key];
      } catch {
        // A live binding that throws on read carries nothing to register.
      }
    }
  }
}

/**
 * Detect a module-namespace object WITHOUT invoking user code.
 *
 * We must not use `Object.prototype.toString.call(value)` or read
 * `value[Symbol.toStringTag]`: both perform a `[[Get]]` that would invoke a
 * user-defined `@@toStringTag` getter as a side effect on every value walked —
 * exactly the side-effect-free property this traversal is meant to preserve.
 *
 * Instead we match the exact `@@toStringTag` shape of a Module Namespace Exotic
 * Object (ECMAScript 28.3 / 10.4.6): an own, non-writable, non-enumerable,
 * non-configurable DATA property whose value is "Module" (verified: SES
 * namespaces expose precisely this). Reading the own descriptor never invokes a
 * getter, and the strict attribute match keeps the classifier from being
 * tricked by an ordinary object that merely carries a (writable/enumerable/
 * configurable) `@@toStringTag` data property or exposes one via an accessor —
 * so getters on non-namespace objects are never run.
 */
function isModuleNamespaceObject(value: object): boolean {
  const tag = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag);
  return tag !== undefined &&
    "value" in tag && tag.value === "Module" &&
    tag.writable === false &&
    tag.enumerable === false &&
    tag.configurable === false;
}
