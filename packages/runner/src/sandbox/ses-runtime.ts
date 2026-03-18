import "npm:ses";
import {
  type JsScript,
  type MappedPosition,
  SourceMapParser,
} from "@commontools/js-compiler";
import { moduleToJSON } from "../builder/json-utils.ts";
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
import { CT_IMPLEMENTATION_REF } from "./types.ts";

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
  private readonly verifiedFunctions = new Map<string, Map<string, Function>>();
  private readonly verifiedFunctionIndex = new Map<string, Function>();

  evaluateBundle(
    compileId: string,
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
      compileId,
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
      typedResult.main = this.qualifyImplementationRefs(compileId, typedResult.main);
      typedResult.exportMap = this.qualifyImplementationRefs(
        compileId,
        typedResult.exportMap,
      );
      this.resetVerifiedFunctions(compileId);
      this.recordVerifiedFunctions(compileId, typedResult.main);
      this.recordVerifiedFunctions(compileId, typedResult.exportMap);
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
  ): Function | undefined {
    return this.verifiedFunctionIndex.get(implementationRef);
  }

  getCompartmentCount(): number {
    return this.compartments.size;
  }

  clear(): void {
    this.compartments.clear();
    this.verifiedFunctions.clear();
    this.verifiedFunctionIndex.clear();
    this.sourceMaps.clear();
  }

  private getCompartment(compileId: string, console: unknown): SESCompartment {
    return this.getCompartmentWithHelpers(compileId, console, {});
  }

  private getCompartmentWithHelpers(
    compileId: string,
    console: unknown,
    runtimeExports: Record<string, unknown>,
  ): SESCompartment {
    const existing = this.compartments.get(compileId);
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
        harden(helpers),
      ),
    ) as SESCompartment;
    this.compartments.set(compileId, compartment);
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
        if (moduleId in runtimeExports) {
          return;
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
          throw new Error("AMD async require() is not allowed in verified bundles");
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
    compileId: string,
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
      typeof (value as Record<string, unknown>).implementationRef === "string" &&
      "implementation" in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).implementation === "function"
    ) {
      let registry = this.verifiedFunctions.get(compileId);
      if (!registry) {
        registry = new Map();
        this.verifiedFunctions.set(compileId, registry);
      }
      const implementationRef = (value as Record<string, unknown>)
        .implementationRef as string;
      const implementation = (value as Record<string, unknown>)
        .implementation as Function;
      registry.set(implementationRef, implementation);
      this.verifiedFunctionIndex.set(implementationRef, implementation);
    }

    if (typeof value === "function") {
      const metadata = value as Function & {
        implementationRef?: string;
        [CT_IMPLEMENTATION_REF]?: string;
      };
      const implementationRef = metadata[CT_IMPLEMENTATION_REF] ??
        metadata.implementationRef;
      if (implementationRef) {
        let registry = this.verifiedFunctions.get(compileId);
        if (!registry) {
          registry = new Map();
          this.verifiedFunctions.set(compileId, registry);
        }
        registry.set(implementationRef, value);
        this.verifiedFunctionIndex.set(implementationRef, value);
      }
    }

    for (const entry of Object.values(value as Record<string, unknown>)) {
      this.recordVerifiedFunctions(compileId, entry, seen);
    }
  }

  private resetVerifiedFunctions(compileId: string): void {
    const existing = this.verifiedFunctions.get(compileId);
    if (existing) {
      for (const implementationRef of existing.keys()) {
        this.verifiedFunctionIndex.delete(implementationRef);
      }
    }
    this.verifiedFunctions.set(compileId, new Map());
  }

  private qualifyImplementationRefs<T>(
    compileId: string,
    value: T,
    seen = new Map<unknown, unknown>(),
  ): T {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return value;
    }
    const existing = seen.get(value);
    if (existing) {
      return existing as T;
    }

    if (typeof value === "function" && this.hasImplementationRef(value)) {
      return this.wrapQualifiedFunction(compileId, value, seen) as T;
    }

    seen.set(value, value);
    this.qualifyOwnImplementationRef(compileId, value);

    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
      if (!descriptor || !("value" in descriptor)) {
        continue;
      }
      const qualified = this.qualifyImplementationRefs(
        compileId,
        descriptor.value,
        seen,
      );
      if (qualified !== descriptor.value) {
        Reflect.set(value as object, key, qualified);
      }
    }
    return value;
  }

  private hasImplementationRef(value: unknown): value is Function & {
    implementationRef?: string;
    [CT_IMPLEMENTATION_REF]?: string;
  } {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return false;
    }
    const carrier = value as {
      implementationRef?: string;
      [CT_IMPLEMENTATION_REF]?: string;
    };
    return typeof (carrier[CT_IMPLEMENTATION_REF] ?? carrier.implementationRef) ===
      "string";
  }

  private qualifyOwnImplementationRef(
    compileId: string,
    value: unknown,
  ): void {
    if (!value || typeof value !== "object") {
      return;
    }

    const carrier = value as { implementationRef?: string };
    if (typeof carrier.implementationRef !== "string") {
      return;
    }
    carrier.implementationRef = this.scopeImplementationRef(
      compileId,
      carrier.implementationRef,
    );
  }

  private scopeImplementationRef(
    compileId: string,
    implementationRef: string,
  ): string {
    const prefix = `${compileId}::`;
    return implementationRef.startsWith(prefix)
      ? implementationRef
      : `${prefix}${implementationRef}`;
  }

  private wrapQualifiedFunction(
    compileId: string,
    original: Function & {
      implementationRef?: string;
      [CT_IMPLEMENTATION_REF]?: string;
    },
    seen: Map<unknown, unknown>,
  ): Function {
    const scopedRef = this.scopeImplementationRef(
      compileId,
      original[CT_IMPLEMENTATION_REF] ?? original.implementationRef!,
    );
    const wrapped = function(this: unknown, ...args: unknown[]) {
      return Reflect.apply(original, this, args);
    };
    seen.set(original, wrapped);
    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(original));

    for (const key of Reflect.ownKeys(original)) {
      if (
        key === "length" ||
        key === "name" ||
        key === "prototype" ||
        key === "arguments" ||
        key === "caller"
      ) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(original, key);
      if (!descriptor) {
        continue;
      }
      if (key === CT_IMPLEMENTATION_REF) {
        Object.defineProperty(wrapped, key, {
          value: scopedRef,
          enumerable: descriptor.enumerable ?? false,
          configurable: true,
          writable: false,
        });
        continue;
      }
      if (key === "implementationRef") {
        Object.defineProperty(wrapped, key, {
          value: scopedRef,
          enumerable: descriptor.enumerable ?? true,
          configurable: true,
          writable: false,
        });
        continue;
      }
      if (key === "toJSON") {
        Object.defineProperty(wrapped, key, {
          value: () => moduleToJSON(wrapped as never),
          enumerable: descriptor.enumerable ?? true,
          configurable: true,
          writable: false,
        });
        continue;
      }
      if ("value" in descriptor) {
        Object.defineProperty(wrapped, key, {
          ...descriptor,
          value: this.qualifyImplementationRefs(
            compileId,
            descriptor.value,
            seen,
          ),
        });
        continue;
      }
      Object.defineProperty(wrapped, key, descriptor);
    }

    if (!Reflect.has(wrapped, CT_IMPLEMENTATION_REF)) {
      Object.defineProperty(wrapped, CT_IMPLEMENTATION_REF, {
        value: scopedRef,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }
    if (!Reflect.has(wrapped, "implementationRef")) {
      Object.defineProperty(wrapped, "implementationRef", {
        value: scopedRef,
        enumerable: true,
        configurable: true,
        writable: false,
      });
    }

    if (Object.isFrozen(original)) {
      Object.freeze(wrapped);
    }
    return wrapped;
  }
}
