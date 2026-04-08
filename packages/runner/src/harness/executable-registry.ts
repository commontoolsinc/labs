import { isPattern, unsafe_verifiedLoadId } from "../builder/types.ts";
import { hardenVerifiedFunction } from "../sandbox/function-hardening.ts";
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
  private readonly verifiedFunctionIndex = new Map<string, HarnessedFunction>();
  private readonly verifiedFunctionLoadIds = new Map<string, string>();
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
    this.verifiedFunctionIndex.clear();
    this.verifiedFunctionLoadIds.clear();
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
      }
    }

    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      this.recordVerifiedFunctions(loadId, descriptor.value, seen);
    }
  }

  private annotateVerifiedPatterns(
    value: unknown,
    loadId: string,
    seen = new Set<unknown>(),
  ): void {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (isPattern(value) && Object.isExtensible(value)) {
      Object.defineProperty(value, unsafe_verifiedLoadId, {
        value: loadId,
        configurable: true,
      });
    }

    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      this.annotateVerifiedPatterns(descriptor.value, loadId, seen);
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

    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      this.collectAssociatedFunctions(
        descriptor.value,
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
