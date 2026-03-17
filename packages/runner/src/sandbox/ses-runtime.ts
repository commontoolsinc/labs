import "npm:ses";
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
    compileId: string,
    implementationRef: string,
  ): Function | undefined {
    return this.verifiedFunctions.get(compileId)?.get(implementationRef);
  }

  getCompartmentCount(): number {
    return this.compartments.size;
  }

  clear(): void {
    this.compartments.clear();
    this.verifiedFunctions.clear();
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
      }
    }

    for (const entry of Object.values(value as Record<string, unknown>)) {
      this.recordVerifiedFunctions(compileId, entry, seen);
    }
  }
}
