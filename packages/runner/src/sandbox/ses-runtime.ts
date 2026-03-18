import "ses";
import {
  type JsScript,
  type MappedPosition,
  SourceMapParser,
} from "@commontools/js-compiler";
import type { Exports } from "../harness/types.ts";
import {
  extractDefinedModuleIds,
  verifyBundlePreflight,
} from "./bundle-preflight.ts";
import {
  createCompartmentGlobals,
  ensureSESLockdown,
} from "./compartment-globals.ts";
import { verifyAMDFactory } from "./module-verifier.ts";
import { CT_IMPLEMENTATION_REF, type VerifiedCallable } from "./types.ts";

interface BundleEvaluationResult {
  main?: Exports;
  exportMap?: Record<string, Exports>;
}

type SESCompartment = {
  evaluate<T>(source: string): T;
};

export class SESRuntime {
  private readonly sourceMaps = new SourceMapParser();
  private readonly compartments = new Map<string, SESCompartment>();
  private readonly verifiedFunctions = new Map<
    string,
    Map<string, VerifiedCallable>
  >();
  private readonly verifiedFunctionIndex = new Map<string, VerifiedCallable>();
  private readonly patternFunctions = new Map<
    string,
    Map<string, VerifiedCallable>
  >();

  evaluateBundle(
    _compileId: string,
    evaluationId: string,
    jsScript: JsScript,
    options: {
      console: unknown;
      runtimeExports: Record<string, unknown>;
    },
  ): BundleEvaluationResult {
    verifyBundlePreflight(jsScript.js);

    if (jsScript.filename && jsScript.sourceMap) {
      this.sourceMaps.load(jsScript.filename, jsScript.sourceMap);
    }

    const compartment = this.getCompartmentWithHelpers(
      evaluationId,
      options.console,
      options.runtimeExports,
    );
    const runtimeDeps = this.createRuntimeDeps(
      jsScript.js,
      options.runtimeExports,
    );

    const bundleFactory = this.withMappedErrors(() =>
      compartment.evaluate<(runtimeDeps?: Record<string, unknown>) => unknown>(
        jsScript.js,
      )
    );
    const result = this.withMappedErrors(() => bundleFactory(runtimeDeps));

    if (
      result && typeof result === "object" && "main" in result &&
      "exportMap" in result
    ) {
      const typedResult = result as {
        main: Exports;
        exportMap: Record<string, Exports>;
      };
      this.resetVerifiedFunctions(evaluationId);
      this.recordVerifiedFunctions(evaluationId, typedResult.main);
      this.recordVerifiedFunctions(evaluationId, typedResult.exportMap);
      return typedResult;
    }

    return {};
  }

  invoke<T>(callback: () => T): T {
    return this.withMappedErrors(callback);
  }

  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    return this.sourceMaps.mapPosition(filename, line, column);
  }

  parseStack(stack: string): string {
    return this.sourceMaps.parse(stack);
  }

  getVerifiedFunction(
    implementationRef: string,
    patternId?: string,
  ): VerifiedCallable | undefined {
    if (patternId) {
      const registry = this.patternFunctions.get(patternId);
      if (registry?.has(implementationRef)) {
        return registry.get(implementationRef);
      }
    }
    return this.verifiedFunctionIndex.get(implementationRef);
  }

  getCompartmentCount(): number {
    return this.compartments.size;
  }

  clear(): void {
    this.compartments.clear();
    this.verifiedFunctions.clear();
    this.verifiedFunctionIndex.clear();
    this.patternFunctions.clear();
    this.sourceMaps.clear();
  }

  associatePattern(patternId: string, value: unknown): void {
    const registry = new Map<string, VerifiedCallable>();
    this.collectAssociatedFunctions(value, registry, new Set());
    this.patternFunctions.set(patternId, registry);
  }

  private getCompartment(
    evaluationId: string,
    console: unknown,
  ): SESCompartment {
    return this.getCompartmentWithHelpers(evaluationId, console, {});
  }

  private getCompartmentWithHelpers(
    evaluationId: string,
    console: unknown,
    runtimeExports: Record<string, unknown>,
  ): SESCompartment {
    const existing = this.compartments.get(evaluationId);
    if (existing) {
      return existing;
    }

    const helpers = (runtimeExports["commontools"] &&
        typeof runtimeExports["commontools"] === "object")
      ? runtimeExports["commontools"] as Record<string, unknown>
      : {};
    ensureSESLockdown();
    const compartment = new Compartment(
      createCompartmentGlobals(
        console as Record<string, unknown>,
        helpers,
      ),
    ) as SESCompartment;
    this.compartments.set(evaluationId, compartment);
    return compartment;
  }

  private createRuntimeDeps(
    bundleSource: string,
    runtimeExports: Record<string, unknown>,
  ): Record<string, unknown> {
    ensureSESLockdown();
    const registeredModuleIds = new Set(extractDefinedModuleIds(bundleSource));
    const hooks = {
      define: (
        moduleId: string,
        dependencies: string[],
        factorySource: string,
      ) => {
        if (!registeredModuleIds.has(moduleId)) {
          return;
        }
        if (moduleId in runtimeExports) {
          throw new Error(
            `Bundle may not redefine trusted runtime module: ${moduleId}`,
          );
        }
        verifyAMDFactory({
          moduleId,
          dependencies,
          registeredModuleIds,
          factorySource,
        });
      },
      require: (dependency: string[] | string) => {
        if (Array.isArray(dependency)) {
          throw new Error(
            "AMD async require() is not allowed in verified bundles",
          );
        }
      },
    };

    return harden({
      ...runtimeExports,
      __ctAmdHooks: harden(hooks),
    });
  }

  private withMappedErrors<T>(callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (error instanceof Error && error.stack) {
        error.stack = this.sourceMaps.parse(error.stack);
      }
      throw error;
    }
  }

  private recordVerifiedFunctions(
    evaluationId: string,
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
      typeof value === "object" &&
      value !== null &&
      "implementationRef" in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).implementationRef ===
        "string" &&
      "implementation" in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).implementation === "function"
    ) {
      let registry = this.verifiedFunctions.get(evaluationId);
      if (!registry) {
        registry = new Map();
        this.verifiedFunctions.set(evaluationId, registry);
      }
      const implementationRef = (value as Record<string, unknown>)
        .implementationRef as string;
      const implementation = (value as Record<string, unknown>)
        .implementation as VerifiedCallable;
      registry.set(implementationRef, implementation);
      this.verifiedFunctionIndex.set(implementationRef, implementation);
    }

    if (typeof value === "function") {
      const metadata = value as VerifiedCallable & {
        implementationRef?: string;
        [CT_IMPLEMENTATION_REF]?: string;
      };
      const implementationRef = metadata[CT_IMPLEMENTATION_REF] ??
        metadata.implementationRef;
      if (implementationRef) {
        let registry = this.verifiedFunctions.get(evaluationId);
        if (!registry) {
          registry = new Map();
          this.verifiedFunctions.set(evaluationId, registry);
        }
        registry.set(implementationRef, value as VerifiedCallable);
        this.verifiedFunctionIndex.set(
          implementationRef,
          value as VerifiedCallable,
        );
      }
    }

    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      this.recordVerifiedFunctions(evaluationId, descriptor.value, seen);
    }
  }

  private resetVerifiedFunctions(evaluationId: string): void {
    const existing = this.verifiedFunctions.get(evaluationId);
    if (existing) {
      for (const implementationRef of existing.keys()) {
        const replacement = this.findVerifiedFunctionInOtherEvaluations(
          evaluationId,
          implementationRef,
        );
        if (replacement) {
          this.verifiedFunctionIndex.set(implementationRef, replacement);
        } else {
          this.verifiedFunctionIndex.delete(implementationRef);
        }
      }
    }
    this.verifiedFunctions.set(evaluationId, new Map());
  }

  private findVerifiedFunctionInOtherEvaluations(
    evaluationId: string,
    implementationRef: string,
  ): VerifiedCallable | undefined {
    let replacement: VerifiedCallable | undefined;
    for (const [otherEvaluationId, registry] of this.verifiedFunctions) {
      if (otherEvaluationId === evaluationId) {
        continue;
      }
      const candidate = registry.get(implementationRef);
      if (candidate) {
        // Prefer the most recently registered surviving evaluation rather than
        // the first one inserted into the global registry.
        replacement = candidate;
      }
    }
    return replacement;
  }

  private collectAssociatedFunctions(
    value: unknown,
    registry: Map<string, VerifiedCallable>,
    seen: Set<unknown>,
  ): void {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    const associated = this.extractAssociatedFunction(value);
    if (associated) {
      registry.set(associated.implementationRef, associated.implementation);
    }

    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      this.collectAssociatedFunctions(descriptor.value, registry, seen);
    }
  }

  private extractAssociatedFunction(
    value: unknown,
  ): { implementationRef: string; implementation: VerifiedCallable } | null {
    if (typeof value === "function") {
      const metadata = value as VerifiedCallable & {
        implementationRef?: string;
        [CT_IMPLEMENTATION_REF]?: string;
      };
      const implementationRef = metadata[CT_IMPLEMENTATION_REF] ??
        metadata.implementationRef;
      return implementationRef
        ? {
          implementationRef,
          implementation: value as VerifiedCallable,
        }
        : null;
    }

    const record = value as {
      implementationRef?: string;
      implementation?: unknown;
    };
    if (typeof record.implementationRef !== "string") {
      return null;
    }
    if (typeof record.implementation === "function") {
      return {
        implementationRef: record.implementationRef,
        implementation: record.implementation as VerifiedCallable,
      };
    }

    const rebound = this.verifiedFunctionIndex.get(record.implementationRef);
    return rebound
      ? { implementationRef: record.implementationRef, implementation: rebound }
      : null;
  }
}
