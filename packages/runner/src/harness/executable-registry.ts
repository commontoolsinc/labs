import { isPattern } from "../builder/types.ts";
import {
  isTrustedPattern,
  setVerifiedLoadId,
} from "../builder/pattern-metadata.ts";
import { hardenVerifiedFunction } from "../sandbox/function-hardening.ts";
import { VERIFIED_BINDING_METADATA_FIELD } from "@commonfabric/utils/sandbox-contract";
import type { UnsafeHostTrustOptions } from "../unsafe-host-trust.ts";
import type { HarnessedFunction } from "./types.ts";

type AssociatedLookup = (
  implementationRef: string,
) => HarnessedFunction | undefined;

interface AssociatedFunction {
  implementationRef: string;
  implementation: HarnessedFunction;
}

export class ExecutableRegistry {
  private readonly verifiedFunctions = new Map<
    string,
    Map<string, HarnessedFunction>
  >();
  private readonly verifiedLoadSources = new Map<string, Set<string>>();
  private readonly verifiedLoadBundleIds = new Map<string, string>();
  private readonly verifiedFunctionIndex = new Map<string, HarnessedFunction>();
  private readonly verifiedFunctionLoadIds = new Map<string, string>();
  private readonly verifiedBindingMetadata = new Map<
    string,
    { sourceFile?: string; bindingPath?: string[] }
  >();
  private readonly verifiedPatternFunctions = new Map<
    string,
    Map<string, HarnessedFunction>
  >();
  private readonly verifiedPatternLoadIds = new Map<string, string>();
  private readonly trustedHostFunctionIndex = new Map<
    string,
    HarnessedFunction
  >();
  private trustedHostFunctionRefs = new WeakMap<HarnessedFunction, string>();
  private nextTrustedHostFunctionId = 0;

  clear(): void {
    this.verifiedFunctions.clear();
    this.verifiedLoadSources.clear();
    this.verifiedLoadBundleIds.clear();
    this.verifiedFunctionIndex.clear();
    this.verifiedFunctionLoadIds.clear();
    this.verifiedBindingMetadata.clear();
    this.verifiedPatternFunctions.clear();
    this.verifiedPatternLoadIds.clear();
    this.trustedHostFunctionIndex.clear();
    this.trustedHostFunctionRefs = new WeakMap();
    this.nextTrustedHostFunctionId = 0;
  }

  beginVerifiedLoad(loadId: string): void {
    const existing = this.verifiedFunctions.get(loadId);
    if (existing) {
      for (const implementationRef of existing.keys()) {
        const replacement = this.findVerifiedFunctionInOtherLoads(
          loadId,
          implementationRef,
        );
        if (replacement) {
          this.verifiedFunctionIndex.set(
            implementationRef,
            replacement.implementation,
          );
          this.verifiedFunctionLoadIds.set(
            implementationRef,
            replacement.loadId,
          );
        } else {
          this.verifiedFunctionIndex.delete(implementationRef);
          this.verifiedFunctionLoadIds.delete(implementationRef);
        }
      }
    }
    this.verifiedFunctions.set(loadId, new Map());
    this.verifiedLoadSources.set(loadId, new Set());
  }

  setVerifiedLoadSources(
    loadId: string,
    sources: Iterable<string>,
  ): void {
    this.verifiedLoadSources.set(loadId, new Set(sources));
  }

  setVerifiedLoadBundleId(loadId: string, bundleId: string): void {
    this.verifiedLoadBundleIds.set(loadId, bundleId);
  }

  registerVerifiedFunction(
    loadId: string,
    implementationRef: string,
    implementation: HarnessedFunction,
  ): void {
    this.storeVerifiedFunction(loadId, implementationRef, implementation);
  }

  createVerifiedFunctionRegistrar(
    loadId: string,
  ): (
    implementationRef: string,
    implementation: (...args: any[]) => unknown,
  ) => void {
    return (implementationRef, implementation) => {
      this.storeVerifiedFunction(
        loadId,
        implementationRef,
        implementation as HarnessedFunction,
      );
    };
  }

  captureVerifiedValue(loadId: string, value: unknown): void {
    this.recordVerifiedFunctions(loadId, value);
    this.annotateVerifiedPatterns(value, loadId);
  }

  getVerifiedFunction(
    implementationRef: string,
    patternId?: string,
  ): HarnessedFunction | undefined {
    if (patternId) {
      const registry = this.verifiedPatternFunctions.get(patternId);
      if (registry?.has(implementationRef)) {
        return registry.get(implementationRef);
      }
    }
    return this.verifiedFunctionIndex.get(implementationRef);
  }

  getVerifiedFunctionInLoad(
    loadId: string,
    implementationRef: string,
  ): HarnessedFunction | undefined {
    return this.verifiedFunctions.get(loadId)?.get(implementationRef);
  }

  isVerifiedSourceInLoad(loadId: string, source: string): boolean {
    return this.verifiedLoadSources.get(loadId)?.has(source) ?? false;
  }

  getVerifiedBundleId(loadId: string): string | undefined {
    return this.verifiedLoadBundleIds.get(loadId);
  }

  getVerifiedBindingMetadata(
    implementationRef: string,
  ): { sourceFile?: string; bindingPath?: string[] } | undefined {
    return this.verifiedBindingMetadata.get(implementationRef);
  }

  getVerifiedLoadId(
    implementationRef: string,
    patternId?: string,
  ): string | undefined {
    return this.verifiedFunctionLoadIds.get(implementationRef) ??
      (patternId ? this.verifiedPatternLoadIds.get(patternId) : undefined);
  }

  getExecutableFunction(
    implementationRef: string,
    patternId?: string,
  ): HarnessedFunction | undefined {
    return this.getVerifiedFunction(implementationRef, patternId) ??
      this.trustedHostFunctionIndex.get(implementationRef);
  }

  associatePattern(patternId: string, value: unknown, loadId?: string): void {
    const registry = new Map<string, HarnessedFunction>();
    this.collectAssociatedFunctions(
      value,
      registry,
      new Set(),
      (implementationRef) => this.getVerifiedFunction(implementationRef),
    );
    this.verifiedPatternFunctions.set(patternId, registry);
    if (loadId) {
      for (const [implementationRef, implementation] of registry) {
        this.storeVerifiedFunction(loadId, implementationRef, implementation);
      }
      this.verifiedPatternLoadIds.set(patternId, loadId);
    }
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
    this.collectAssociatedFunctions(
      value,
      registry,
      new Set(),
      undefined,
      true,
    );
    for (const [implementationRef, implementation] of registry) {
      this.trustedHostFunctionIndex.set(implementationRef, implementation);
    }
  }

  private storeVerifiedFunction(
    loadId: string,
    implementationRef: string,
    implementation: HarnessedFunction,
  ): void {
    let registry = this.verifiedFunctions.get(loadId);
    if (!registry) {
      registry = new Map();
      this.verifiedFunctions.set(loadId, registry);
    }
    registry.set(implementationRef, implementation);
    this.verifiedFunctionIndex.set(implementationRef, implementation);
    this.verifiedFunctionLoadIds.set(implementationRef, loadId);
    this.recordVerifiedBindingMetadata(implementationRef, implementation);
  }

  private recordVerifiedFunctions(
    loadId: string,
    value: unknown,
    seen = new Set<unknown>(),
  ): void {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      "implementationRef" in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).implementationRef ===
        "string" &&
      "implementation" in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).implementation === "function"
    ) {
      const implementationRef = (value as Record<string, unknown>)
        .implementationRef as string;
      const implementation = (value as Record<string, unknown>)
        .implementation as HarnessedFunction;
      this.storeVerifiedFunction(loadId, implementationRef, implementation);
      this.recordVerifiedBindingMetadata(implementationRef, value);
    }

    if (
      typeof value === "function" &&
      typeof (value as { implementation?: unknown }).implementation !==
        "function"
    ) {
      const implementationRef = (value as { implementationRef?: string })
        .implementationRef;
      if (implementationRef) {
        this.storeVerifiedFunction(
          loadId,
          implementationRef,
          value as HarnessedFunction,
        );
        this.recordVerifiedBindingMetadata(implementationRef, value);
      }
    }

    for (const child of verifiedWalkChildValues(value as object)) {
      this.recordVerifiedFunctions(loadId, child, seen);
    }
  }

  private recordVerifiedBindingMetadata(
    implementationRef: string,
    value: unknown,
  ): void {
    const metadata = readVerifiedBindingMetadata(value);
    if (!metadata) {
      return;
    }
    this.verifiedBindingMetadata.set(implementationRef, metadata);
  }

  private annotateVerifiedPatterns(
    value: unknown,
    loadId: string,
    seen = new Map<unknown, boolean>(),
    trusted = false,
  ): void {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return;
    }

    // Trust is rooted at a builder-produced (`isTrustedPattern`) value; once
    // inside a trusted pattern's subtree, nested (serialized, unbranded)
    // subpatterns inherit the id via structural `isPattern`. A `__cf_data`-forged
    // pattern-shaped value at the top level (trusted === false) is never
    // annotated, so it cannot launder a CFC identity into the side-table.
    const subtreeTrusted = trusted || isTrustedPattern(value);

    // `seen` records the trust level a node was visited at, so a node reached
    // first via an untrusted path is still re-processed when later reached via a
    // trusted path — order-independent. A trusted visit is final.
    const prior = seen.get(value);
    if (prior === true || (prior === false && !subtreeTrusted)) {
      return;
    }
    seen.set(value, subtreeTrusted);

    if (subtreeTrusted && isPattern(value)) {
      // Side-table storage works on frozen patterns too (no own-property write).
      setVerifiedLoadId(value, loadId);
    }

    for (const child of verifiedWalkChildValues(value as object)) {
      this.annotateVerifiedPatterns(
        child,
        loadId,
        seen,
        subtreeTrusted,
      );
    }
  }

  private findVerifiedFunctionInOtherLoads(
    loadId: string,
    implementationRef: string,
  ): { implementation: HarnessedFunction; loadId: string } | undefined {
    let replacement:
      | { implementation: HarnessedFunction; loadId: string }
      | undefined;
    for (const [otherLoadId, registry] of this.verifiedFunctions) {
      if (otherLoadId === loadId) {
        continue;
      }
      const candidate = registry.get(implementationRef);
      if (candidate) {
        replacement = {
          implementation: candidate,
          loadId: otherLoadId,
        };
      }
    }
    return replacement;
  }

  private collectAssociatedFunctions(
    value: unknown,
    registry: Map<string, HarnessedFunction>,
    seen: Set<unknown>,
    fallbackLookup?: AssociatedLookup,
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
      fallbackLookup,
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
        fallbackLookup,
        allowMintMissingRefs,
      );
    }
  }

  private extractAssociatedFunction(
    value: unknown,
    fallbackLookup?: AssociatedLookup,
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
    if (typeof record.implementationRef !== "string") {
      return null;
    }

    const rebound = fallbackLookup?.(record.implementationRef);
    return rebound
      ? {
        implementationRef: record.implementationRef,
        implementation: rebound,
      }
      : null;
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
 * (used by {@link ExecutableRegistry.recordVerifiedFunctions},
 * `annotateVerifiedPatterns`, and `collectAssociatedFunctions`).
 *
 * Data properties — the AMD/CommonJS bundle shape (`exports.x = …`) — expose
 * their value directly. SES module-namespace exports — the ESM module-record
 * loader shape — are live-binding ACCESSOR properties (`get`/`set`, no `value`).
 * Reading only `descriptor.value` therefore never descends into an ESM module's
 * exports, so verified functions, their binding metadata
 * (`__cfVerifiedBindingIdentity`), and exported patterns defined by ESM-loaded
 * modules were never registered/annotated. That left the writer's verified
 * binding identity (`sourceFile`/`bindingPath`) unresolved, so CFC
 * `writeAuthorizedBy` rejected trusted-action writes under the ESM loader
 * (CT-1623).
 *
 * Reading via [[Get]] is scoped to genuine module namespaces (`[object
 * Module]`), whose getters are spec-defined live bindings with no
 * user-controlled side effects. Getters on ordinary objects are deliberately
 * NOT invoked, preserving the side-effect-free walk over data values.
 */
export function* verifiedWalkChildValues(value: object): Generator<unknown> {
  const isModuleNamespace =
    Object.prototype.toString.call(value) === "[object Module]";
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

function readVerifiedBindingMetadata(
  value: unknown,
): { sourceFile?: string; bindingPath?: string[] } | undefined {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const metadata =
    (value as Record<string, unknown>)[VERIFIED_BINDING_METADATA_FIELD];
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const sourceFile = typeof (metadata as Record<string, unknown>).sourceFile ===
      "string"
    ? (metadata as Record<string, unknown>).sourceFile as string
    : undefined;
  const bindingPath = Array.isArray(
      (metadata as Record<string, unknown>).bindingPath,
    ) &&
      ((metadata as Record<string, unknown>).bindingPath as unknown[]).every((
        entry,
      ) => typeof entry === "string")
    ? [...((metadata as Record<string, unknown>).bindingPath as string[])]
    : undefined;
  if (!sourceFile && !bindingPath) {
    return undefined;
  }
  return { sourceFile, bindingPath };
}
